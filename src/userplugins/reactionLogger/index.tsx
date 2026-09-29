/*
 * ReactionLogger - a Vencord userplugin.
 *
 * Works like MessageLogger, but for reactions: when a reaction is removed
 * (by its owner, by a moderator, or in bulk) it stays visible under the
 * message in a grayed-out, red-tinted "removed" pill.
 *
 * Drop this folder in `src/userplugins/reactionLogger/` (together with
 * styles.css) and rebuild Vencord.
 */

import { definePluginSettings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import {
    Button,
    ChannelStore,
    FluxDispatcher,
    GuildMemberStore,
    MessageStore,
    Tooltip,
    useEffect,
    UserStore,
    useState
} from "@webpack/common";

import style from "./styles.css?managed";

const logger = new Logger("ReactionLogger");

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

type RemovalReason = "single" | "all" | "emoji";

interface LoggedEmoji {
    /** Snowflake for custom emoji, null for unicode emoji. */
    id: string | null;
    /** Emoji name. For unicode emoji this is the character itself. */
    name: string | null;
    animated: boolean;
    /** CDN URL for custom emoji, null for unicode emoji. */
    url: string | null;
}

interface RemovedReaction {
    messageId: string;
    channelId: string;
    emoji: LoggedEmoji;
    /** `id ?? name` - used to group pills and to match against live reactions. */
    emojiKey: string;
    /**
     * Whoever's reaction was removed. Discord only tells us this for single
     * removals; for REMOVE_ALL / REMOVE_EMOJI it is null (unknown users).
     */
    userId: string | null;
    /** How many reactions this entry stands for (>1 only for bulk removals). */
    count: number;
    removedAt: number;
    reason: RemovalReason;
    burst: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                  Settings                                  */
/* -------------------------------------------------------------------------- */

const settings = definePluginSettings({
    logRemovals: {
        type: OptionType.BOOLEAN,
        description: "Log removed reactions",
        default: true
    },
    ignoreOwnRemovals: {
        type: OptionType.BOOLEAN,
        description: "Don't log reactions that you removed yourself",
        default: false
    },
    maxCachedReactions: {
        type: OptionType.NUMBER,
        description: "Maximum number of removed reactions kept in memory (oldest are dropped first)",
        default: 500
    },
    clearCache: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button color={Button.Colors.RED} size={Button.Sizes.SMALL} onClick={clearAll}>
                Clear cached reactions
            </Button>
        )
    }
});

/* -------------------------------------------------------------------------- */
/*                         In-memory store (+ subscribers)                    */
/* -------------------------------------------------------------------------- */

const byMessage = new Map<string, RemovedReaction[]>();
/** Insertion-ordered, used to evict the oldest entries. */
const queue: RemovedReaction[] = [];
/** Listeners get the affected messageId, or null when everything changed. */
const listeners = new Set<(messageId: string | null) => void>();

function notify(messageId: string | null) {
    for (const l of listeners) {
        try { l(messageId); } catch (e) { logger.error("listener threw", e); }
    }
}

function removeEntry(entry: RemovedReaction) {
    const list = byMessage.get(entry.messageId);
    if (list) {
        const i = list.indexOf(entry);
        if (i !== -1) list.splice(i, 1);
        if (!list.length) byMessage.delete(entry.messageId);
    }
    const qi = queue.indexOf(entry);
    if (qi !== -1) queue.splice(qi, 1);
}

function trim() {
    const max = Math.max(1, Math.floor(Number(settings.store.maxCachedReactions) || 500));
    while (queue.length > max) {
        const oldest = queue[0];
        removeEntry(oldest);
        notify(oldest.messageId);
    }
}

function addEntry(entry: RemovedReaction) {
    let list = byMessage.get(entry.messageId);

    // Same emoji + same user already logged -> just refresh it instead of duplicating.
    const dup = list?.find(e => e.emojiKey === entry.emojiKey && e.userId === entry.userId);
    if (dup) {
        dup.removedAt = entry.removedAt;
        dup.count = entry.count;
        dup.reason = entry.reason;
        notify(entry.messageId);
        return;
    }

    if (!list) byMessage.set(entry.messageId, list = []);
    list.push(entry);
    queue.push(entry);
    trim();
    notify(entry.messageId);
}

function clearAll() {
    byMessage.clear();
    queue.length = 0;
    notify(null);
}

/* -------------------------------------------------------------------------- */
/*                               Flux handling                                */
/* -------------------------------------------------------------------------- */

function normalizeEmoji(raw: any): { emoji: LoggedEmoji; key: string; } | null {
    if (!raw) return null;
    const id: string | null = raw.id ?? null;
    const name: string | null = raw.name ?? null;
    if (id == null && !name) return null;

    return {
        key: String(id ?? name),
        emoji: {
            id,
            name,
            animated: !!raw.animated,
            url: id ? `https://cdn.discordapp.com/emojis/${id}.${raw.animated ? "gif" : "png"}?size=32` : null
        }
    };
}

/** MESSAGE_REACTION_REMOVE: { channelId, messageId, userId, emoji, optimistic?, burst? } */
function onRemove(action: any) {
    const { channelId, messageId, userId, optimistic } = action;
    // Own removals are dispatched twice: an optimistic one and the gateway echo.
    // We only log the gateway one.
    if (optimistic) return;
    if (!channelId || !messageId || !userId) return;
    if (settings.store.ignoreOwnRemovals && userId === UserStore.getCurrentUser()?.id) return;

    const parsed = normalizeEmoji(action.emoji);
    if (!parsed) return;

    addEntry({
        messageId,
        channelId,
        emoji: parsed.emoji,
        emojiKey: parsed.key,
        userId,
        count: 1,
        removedAt: Date.now(),
        reason: "single",
        burst: !!action.burst || action.reactionType === 1
    });
}

/**
 * MESSAGE_REACTION_REMOVE_ALL: { channelId, messageId }
 * The payload has no reaction info, so we read the message's reactions from
 * MessageStore. This only works because we run as an interceptor, i.e. BEFORE
 * the stores have processed the event.
 */
function onRemoveAll(action: any) {
    const { channelId, messageId } = action;
    if (!channelId || !messageId) return;

    const reactions = MessageStore.getMessage(channelId, messageId)?.reactions;
    if (!Array.isArray(reactions) || !reactions.length) return;

    const now = Date.now();
    for (const r of reactions) {
        const parsed = normalizeEmoji(r?.emoji);
        if (!parsed) continue;
        addEntry({
            messageId,
            channelId,
            emoji: parsed.emoji,
            emojiKey: parsed.key,
            userId: null,
            count: r.count ?? 1,
            removedAt: now,
            reason: "all",
            burst: false
        });
    }
}

/** MESSAGE_REACTION_REMOVE_EMOJI: { channelId, messageId, emoji } */
function onRemoveEmoji(action: any) {
    const { channelId, messageId } = action;
    if (!channelId || !messageId) return;

    const parsed = normalizeEmoji(action.emoji);
    if (!parsed) return;

    const reactions = MessageStore.getMessage(channelId, messageId)?.reactions;
    const live = Array.isArray(reactions)
        ? reactions.find((r: any) => String(r?.emoji?.id ?? r?.emoji?.name) === parsed.key)
        : null;
    if (!live) return;

    addEntry({
        messageId,
        channelId,
        emoji: parsed.emoji,
        emojiKey: parsed.key,
        userId: null,
        count: live.count ?? 1,
        removedAt: Date.now(),
        reason: "emoji",
        burst: false
    });
}

/** MESSAGE_REACTION_ADD: if someone re-adds a logged reaction, it's no longer "removed". */
function onAdd(action: any) {
    const { messageId, userId } = action;
    if (!messageId || !userId) return;

    const parsed = normalizeEmoji(action.emoji);
    const list = byMessage.get(messageId);
    if (!parsed || !list) return;

    const match = list.find(e => e.emojiKey === parsed.key && e.userId === userId);
    if (match) {
        removeEntry(match);
        notify(messageId);
    }
}

let active = false;

function handleAction(action: any) {
    if (!active || !settings.store.logRemovals || !action?.type) return;

    try {
        switch (action.type) {
            case "MESSAGE_REACTION_REMOVE": return onRemove(action);
            case "MESSAGE_REACTION_REMOVE_ALL": return onRemoveAll(action);
            case "MESSAGE_REACTION_REMOVE_EMOJI": return onRemoveEmoji(action);
            case "MESSAGE_REACTION_ADD": return onAdd(action);
        }
    } catch (e) {
        // Never let a bug in here break Discord's dispatch loop.
        logger.error(`Failed handling ${action.type}`, e);
    }
}

/** Interceptor: sees every action before any store; must return falsy to let it through. */
const interceptor = (action: any) => {
    handleAction(action);
    return false;
};

const FALLBACK_EVENTS = [
    "MESSAGE_REACTION_REMOVE",
    "MESSAGE_REACTION_REMOVE_ALL",
    "MESSAGE_REACTION_REMOVE_EMOJI",
    "MESSAGE_REACTION_ADD"
] as const;

let usingFallback = false;

/* -------------------------------------------------------------------------- */
/*                                     UI                                     */
/* -------------------------------------------------------------------------- */

function getUserLabel(entry: RemovedReaction): string {
    if (!entry.userId) {
        const n = entry.count > 1 ? ` (${entry.count})` : "";
        return (entry.reason === "all"
            ? "Unknown user(s) - all reactions cleared"
            : "Unknown user(s) - emoji cleared") + n;
    }

    const user = UserStore.getUser(entry.userId);
    const guildId = ChannelStore.getChannel(entry.channelId)?.guild_id;
    const nick = guildId ? GuildMemberStore.getNick(guildId, entry.userId) : null;
    return nick ?? user?.globalName ?? user?.username ?? entry.userId;
}

function PillTooltip({ group }: { group: RemovedReaction[]; }) {
    const { emoji } = group[0];
    const label = emoji.id ? `:${emoji.name}:` : emoji.name;

    return (
        <div className="vc-reaction-logger-tooltip">
            <div className="vc-reaction-logger-tooltip-title">Removed reaction {label}</div>
            {group.map((e, i) => (
                <div key={`${e.userId ?? "unknown"}-${i}`} className="vc-reaction-logger-tooltip-line">
                    <span className="vc-reaction-logger-user">{getUserLabel(e)}</span>
                    {e.burst && <span className="vc-reaction-logger-time"> (super)</span>}
                    <span className="vc-reaction-logger-time"> - {new Date(e.removedAt).toLocaleString()}</span>
                </div>
            ))}
        </div>
    );
}

function RemovedPill({ group }: { group: RemovedReaction[]; }) {
    const { emoji } = group[0];
    const total = group.reduce((sum, e) => sum + (e.count || 1), 0);

    return (
        <Tooltip text={<PillTooltip group={group} />}>
            {tooltipProps => (
                <div {...tooltipProps} className="vc-reaction-logger-pill">
                    {emoji.url
                        ? <img className="vc-reaction-logger-emoji" src={emoji.url} alt={emoji.name ?? "emoji"} draggable={false} />
                        : <span className="vc-reaction-logger-emoji vc-reaction-logger-unicode">{emoji.name}</span>}
                    <span className="vc-reaction-logger-count">{total}</span>
                </div>
            )}
        </Tooltip>
    );
}

function RemovedReactionsRow({ message }: { message?: { id?: string; }; }) {
    const messageId = message?.id;
    const [, setTick] = useState(0);

    // Re-render whenever the store changes for this message (or is cleared).
    useEffect(() => {
        if (!messageId) return;
        const listener = (changedId: string | null) => {
            if (changedId === null || changedId === messageId) setTick(t => t + 1);
        };
        listeners.add(listener);
        return () => void listeners.delete(listener);
    }, [messageId]);

    if (!messageId) return null;
    const entries = byMessage.get(messageId);
    if (!entries?.length) return null;

    // One pill per emoji, with all removers grouped in its tooltip.
    const groups = new Map<string, RemovedReaction[]>();
    for (const e of entries) {
        const g = groups.get(e.emojiKey);
        if (g) g.push(e); else groups.set(e.emojiKey, [e]);
    }

    return (
        <div className="vc-reaction-logger-row">
            <span className="vc-reaction-logger-badge">Removed</span>
            {[...groups.values()].map(group => (
                <RemovedPill key={group[0].emojiKey} group={group} />
            ))}
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/*                                   Plugin                                   */
/* -------------------------------------------------------------------------- */

export default definePlugin({
    name: "ReactionLogger",
    description: "Like MessageLogger, but for reactions: removed reactions stay visible under the message, grayed out with a red tint.",
    authors: [{ name: "OlieW", id: 0n }],
    dependencies: ["MessageAccessoriesAPI"],
    settings,

    start() {
        active = true;
        enableStyle(style);

        const dispatcher = FluxDispatcher as any;
        if (typeof dispatcher.addInterceptor === "function") {
            dispatcher.addInterceptor(interceptor);
            usingFallback = false;
        } else {
            // Degraded mode: plain subscriptions run after/alongside the stores, so
            // REMOVE_ALL / REMOVE_EMOJI may not find the reactions any more.
            logger.warn("FluxDispatcher.addInterceptor missing, falling back to subscribe()");
            for (const type of FALLBACK_EVENTS) FluxDispatcher.subscribe(type, handleAction);
            usingFallback = true;
        }
    },

    stop() {
        active = false; // makes the interceptor a no-op even if removal below fails
        disableStyle(style);

        const dispatcher = FluxDispatcher as any;
        if (usingFallback) {
            for (const type of FALLBACK_EVENTS) FluxDispatcher.unsubscribe(type, handleAction);
        } else {
            const list: unknown[] | undefined = dispatcher._interceptors;
            const i = list?.indexOf(interceptor) ?? -1;
            if (i !== -1) list!.splice(i, 1);
        }

        clearAll();
    },

    /**
     * Rendered by MessageAccessoriesAPI below each message's content, so no
     * fragile regex patch on Discord's minified reaction component is needed.
     */
    renderMessageAccessory: props => (
        <ErrorBoundary noop>
            <RemovedReactionsRow message={props.message} />
        </ErrorBoundary>
    )
});
