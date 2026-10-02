/*
 * ReactionLogger - a Vencord userplugin.
 *
 * Works like MessageLogger, but for reactions: when a reaction is removed
 * (by its owner, by a moderator, or in bulk) it stays visible under the
 * message in a grayed-out, red-tinted "removed" pill.
 *
 * Interactions:
 *  - Hover a removed pill            -> details card (stays open while hovered)
 *  - Click a name in the card        -> copies that user's ID
 *  - Click a removed pill            -> dismiss it
 *  - Message context menu            -> clear this message's logged reactions
 *
 * Drop this folder in `src/userplugins/reactionLogger/` (together with
 * styles.css) and rebuild Vencord.
 */

import { get as dsGet, set as dsSet } from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import {
    Button,
    ChannelStore,
    FluxDispatcher,
    GuildMemberStore,
    Menu,
    MessageStore,
    ReactDOM,
    useEffect,
    useRef,
    UserStore,
    UserUtils,
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
    /**
     * "Nickname (username)" saved when the reaction was logged (or looked up
     * later). Discord's local user cache is empty after a restart, so without
     * this the log would fall back to showing raw user IDs.
     */
    userLabel: string | null;
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
    persistLog: {
        type: OptionType.BOOLEAN,
        description: "Save removed reactions so they survive restarts",
        default: true,
        onChange: (enabled: boolean) => {
            // Turning it on mid-session: load the saved log first so it isn't overwritten.
            if (enabled && active) void loadLog();
        }
    },
    maxCachedReactions: {
        type: OptionType.NUMBER,
        description: "Maximum number of removed reactions kept (oldest are dropped first). Applies to the saved log too.",
        default: 500
    },
    clearCache: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button color={Button.Colors.RED} size={Button.Sizes.SMALL} onClick={() => clearLogged()}>
                Clear all logged reactions
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
    scheduleSave();
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
        dup.userLabel = entry.userLabel ?? dup.userLabel;
        notify(entry.messageId);
        return;
    }

    if (!list) byMessage.set(entry.messageId, list = []);
    list.push(entry);
    queue.push(entry);
    trim();
    notify(entry.messageId);
}

/**
 * Clears logged reactions.
 * Pass a messageId to clear only that message, or nothing to clear everything.
 */
function clearLogged(messageId?: string) {
    const source = messageId ? (byMessage.get(messageId) ?? []) : queue;
    // Copy first: removeEntry mutates the arrays we're iterating over.
    for (const entry of [...source]) removeEntry(entry);
    notify(messageId ?? null);
}

/** Wipes everything from memory (used when the plugin stops). */
function resetAll() {
    byMessage.clear();
    queue.length = 0;
    notify(null);
}

/** Click on a pill: drop every entry of that emoji on that message. */
function dismissGroup(group: RemovedReaction[]) {
    if (!group.length) return;
    for (const entry of group) removeEntry(entry);
    notify(group[0].messageId);
}

/* -------------------------------------------------------------------------- */
/*                              User name lookup                              */
/* -------------------------------------------------------------------------- */

/**
 * "Nickname (username)" from Discord's local caches, or null if the user isn't
 * cached. Shows just the username when there's no different nickname/display name.
 */
function formatUserLabel(userId: string, channelId: string): string | null {
    const user = UserStore.getUser(userId);
    if (!user) return null;

    const guildId = ChannelStore.getChannel(channelId)?.guild_id;
    const nick = guildId ? GuildMemberStore.getNick(guildId, userId) : null;
    const display = nick ?? user.globalName ?? user.username;

    return display !== user.username ? `${display} (${user.username})` : user.username;
}

const pendingFetches = new Set<string>();
const failedFetches = new Set<string>();

/**
 * Asks Discord for a user that isn't cached (e.g. an entry restored from disk
 * before the user was ever loaded), then saves the resulting label on every
 * entry of that user. Runs at most once per user per session.
 */
async function fetchUserLabel(userId: string): Promise<void> {
    if (pendingFetches.has(userId) || failedFetches.has(userId)) return;
    pendingFetches.add(userId);

    try {
        await UserUtils.getUser(userId);

        let changed = false;
        for (const e of queue) {
            if (e.userId !== userId) continue;
            const label = formatUserLabel(userId, e.channelId);
            if (label && label !== e.userLabel) {
                e.userLabel = label;
                changed = true;
            }
        }

        if (changed) notify(null);
        else failedFetches.add(userId);
    } catch (e) {
        // Deleted account, rate limit, ... - don't retry this session.
        failedFetches.add(userId);
        logger.warn(`Could not look up user ${userId}`, e);
    } finally {
        pendingFetches.delete(userId);
    }
}

/* -------------------------------------------------------------------------- */
/*                         Persistence (Vencord DataStore)                    */
/* -------------------------------------------------------------------------- */

// DataStore is Vencord's IndexedDB wrapper: data lives in Discord's profile
// on disk, so it survives restarts. The cap is `maxCachedReactions`.
const STORAGE_KEY = "ReactionLogger_removedReactions";

/** True once the saved log has been loaded; saving before that would overwrite it. */
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function isValidEntry(e: any): boolean {
    return !!e
        && typeof e.messageId === "string"
        && typeof e.channelId === "string"
        && typeof e.emojiKey === "string"
        && typeof e.removedAt === "number"
        && !!e.emoji
        && (typeof e.emoji.name === "string" || typeof e.emoji.id === "string")
        && (e.userId === null || typeof e.userId === "string");
}

/** Writes the current log to disk right now. Takes its snapshot synchronously. */
async function saveNow(): Promise<void> {
    if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
    }

    const snapshot = queue.map(e => ({ ...e, emoji: { ...e.emoji } }));
    try {
        await dsSet(STORAGE_KEY, snapshot);
    } catch (e) {
        logger.error("Failed to save removed reactions", e);
    }
}

/** Debounced save, called after every change to the log. */
function scheduleSave() {
    if (!loaded || !settings.store.persistLog) return;
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(), 500);
}

/** Restores the saved log and merges it with anything logged while loading. */
async function loadLog(): Promise<void> {
    if (!settings.store.persistLog) return;

    try {
        const saved = await dsGet<unknown>(STORAGE_KEY);
        const restored: RemovedReaction[] = Array.isArray(saved)
            ? saved.filter(isValidEntry).map(e => ({
                messageId: e.messageId,
                channelId: e.channelId,
                emoji: e.emoji,
                emojiKey: e.emojiKey,
                userId: e.userId ?? null,
                userLabel: typeof e.userLabel === "string" ? e.userLabel : null,
                count: Number(e.count) || 1,
                removedAt: e.removedAt,
                reason: e.reason ?? "single",
                burst: !!e.burst
            }))
            : [];

        const merged = [...restored, ...queue].sort((a, b) => a.removedAt - b.removedAt);
        byMessage.clear();
        queue.length = 0;

        for (const e of merged) {
            const list = byMessage.get(e.messageId);
            if (list?.some(x => x.emojiKey === e.emojiKey && x.userId === e.userId)) continue;
            if (list) list.push(e); else byMessage.set(e.messageId, [e]);
            queue.push(e);
        }

        trim();
        loaded = true;
        notify(null); // re-renders visible rows and saves the merged result
    } catch (e) {
        // Leave `loaded` false so a failed read never overwrites the saved log.
        logger.error("Failed to load saved reactions", e);
    }
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
        // Save the name now, while Discord still has the user cached.
        userLabel: formatUserLabel(userId, channelId),
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
            userLabel: null,
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
        userLabel: null,
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

    // Live lookup first (picks up nickname changes), then the saved label,
    // and only as a last resort the raw ID.
    return formatUserLabel(entry.userId, entry.channelId) ?? entry.userLabel ?? entry.userId;
}

/** Contents of the hover card. */
function PillDetails({ group }: { group: RemovedReaction[]; }) {
    const { emoji } = group[0];
    const label = emoji.id ? `:${emoji.name}:` : emoji.name;

    // Look up users Discord hasn't cached (once per user per session).
    useEffect(() => {
        for (const e of group) {
            if (e.userId && !e.userLabel && !formatUserLabel(e.userId, e.channelId)) {
                void fetchUserLabel(e.userId);
            }
        }
    });

    return (
        <>
            <div className="vc-reaction-logger-popover-title">Removed reaction {label}</div>
            {group.map((e, i) => (
                <div key={`${e.userId ?? "unknown"}-${i}`} className="vc-reaction-logger-popover-line">
                    {e.userId
                        ? (
                            <span
                                className="vc-reaction-logger-user vc-reaction-logger-copyable"
                                role="button"
                                onClick={() => copyWithToast(e.userId!, "User ID copied!")}
                            >
                                {getUserLabel(e)}
                            </span>
                        )
                        : <span className="vc-reaction-logger-user">{getUserLabel(e)}</span>}
                    {e.burst && <span className="vc-reaction-logger-time"> (super)</span>}
                    <span className="vc-reaction-logger-time"> - {new Date(e.removedAt).toLocaleString()}</span>
                </div>
            ))}
            <div className="vc-reaction-logger-hint">
                Click a name: copy user ID - Click the pill: remove
            </div>
        </>
    );
}

interface PopoverPos {
    left: number;
    top?: number;
    bottom?: number;
}

function RemovedPill({ group }: { group: RemovedReaction[]; }) {
    const { emoji } = group[0];
    const total = group.reduce((sum, e) => sum + (e.count || 1), 0);

    const pillRef = useRef<HTMLDivElement>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [pos, setPos] = useState<PopoverPos | null>(null);

    const cancelClose = () => {
        if (closeTimer.current !== undefined) {
            clearTimeout(closeTimer.current);
            closeTimer.current = undefined;
        }
    };

    // Small delay so the mouse can travel from the pill into the card.
    const scheduleClose = () => {
        cancelClose();
        closeTimer.current = setTimeout(() => setPos(null), 150);
    };

    const open = () => {
        cancelClose();
        const el = pillRef.current;
        if (!el) return;

        const r = el.getBoundingClientRect();
        const left = Math.max(8, Math.min(r.left, window.innerWidth - 360));
        // Prefer showing above the pill; go below if there's no room.
        setPos(r.top > 170
            ? { left, bottom: window.innerHeight - r.top + 6 }
            : { left, top: r.bottom + 6 });
    };

    useEffect(() => cancelClose, []);

    // The card is position:fixed, so close it if the chat scrolls underneath it.
    const isOpen = pos !== null;
    useEffect(() => {
        if (!isOpen) return;
        const close = () => setPos(null);
        window.addEventListener("scroll", close, true);
        return () => window.removeEventListener("scroll", close, true);
    }, [isOpen]);

    return (
        <>
            <div
                ref={pillRef}
                className="vc-reaction-logger-pill"
                role="button"
                onMouseEnter={open}
                onMouseLeave={scheduleClose}
                onClick={() => dismissGroup(group)}
            >
                {emoji.url
                    ? <img className="vc-reaction-logger-emoji" src={emoji.url} alt={emoji.name ?? "emoji"} draggable={false} />
                    : <span className="vc-reaction-logger-emoji vc-reaction-logger-unicode">{emoji.name}</span>}
                <span className="vc-reaction-logger-count">{total}</span>
            </div>

            {/*
              * Rendered in a portal on <body> so the chat's overflow clipping can't cut it off.
              * It is a sibling of the pill (not a child), and stops click/context-menu events,
              * so interacting with the card never triggers the pill's "dismiss" click or
              * Discord's message handlers.
              */}
            {pos && ReactDOM.createPortal(
                <div
                    className="vc-reaction-logger-popover"
                    style={{ left: pos.left, top: pos.top, bottom: pos.bottom }}
                    onMouseEnter={cancelClose}
                    onMouseLeave={scheduleClose}
                    onClick={e => e.stopPropagation()}
                    onContextMenu={e => e.stopPropagation()}
                >
                    <PillDetails group={group} />
                </div>,
                document.body
            )}
        </>
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

    // One pill per emoji, with all removers grouped in its hover card.
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
        void loadLog();

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

        // Flush the log to disk first, then stop saving so the wipe below
        // (which only clears memory) can't overwrite it with an empty list.
        if (loaded && settings.store.persistLog) void saveNow();
        if (saveTimer !== undefined) clearTimeout(saveTimer);
        saveTimer = undefined;
        loaded = false;

        resetAll();
    },

    /**
     * Rendered by MessageAccessoriesAPI below each message's content, so no
     * fragile regex patch on Discord's minified reaction component is needed.
     */
    renderMessageAccessory: props => (
        <ErrorBoundary noop>
            <RemovedReactionsRow message={props.message} />
        </ErrorBoundary>
    ),

    /** Adds a clear button to the message right-click menu (like MessageLogger's "Remove Message History"). */
    contextMenus: {
        "message": (children, props) => {
            const messageId: string | undefined = props?.message?.id;
            const hasHere = !!messageId && !!byMessage.get(messageId)?.length;
            if (!hasHere) return;

            children.push(
                <Menu.MenuGroup>
                    <Menu.MenuItem
                        id="vc-reaction-logger-clear-message"
                        label="Clear Logged Reactions"
                        color="danger"
                        action={() => clearLogged(messageId)}
                    />
                </Menu.MenuGroup>
            );
        }
    }
});
