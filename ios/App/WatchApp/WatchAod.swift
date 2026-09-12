import Foundation

/// What the dimmed (Always On) screen should show for the current session.
///
/// The Always On state is the only state where the Watch keeps drawing while the
/// user is not interacting, and the screen is dimmed and refreshed at a much lower
/// rate. Showing a timer, a mode name or a black screen there hides the very thing
/// the user is holding their wrist up to read — and the black branch used to fire
/// whenever `listening` was false, which is also true the moment a session ends
/// while its question/answer or original/translation is still on screen.
///
/// This decision is pure so the display branch can be verified without a device:
/// the view renders `idle` as a black screen, `platform` as the save/end/drain
/// status, and `content` as the current copy.
struct WatchAodDisplay: Equatable {
    enum Kind: Equatable {
        /// Nothing to read: the app is on Ready, or the session was abandoned.
        case idle
        /// The platform owns the screen (Save prompt, saved ack, sending the tail).
        case platform
        /// The live question/answer or original/translation.
        case content
    }

    let kind: Kind
    /// The session keeps drawing (listening or paused); the mode chip stays visible.
    let active: Bool
    /// The copy failed on the phone, so the dim screen must not read as still coming.
    let copyFailed: Bool
}

enum WatchAod {
    /// Should the dimmed screen keep the session's current copy?
    ///
    /// `hasContent` is the caller's "either the original or the translation has
    /// text" check, mirroring `qaPage`/`translatePage`, so the Always On branch and
    /// the live page agree on when there is something to read.
    static func display(
        draining: Bool,
        drainFailed: Bool,
        offeringSave: Bool,
        pendingSync: Bool,
        savedAck: Bool,
        listening: Bool,
        paused: Bool,
        hasContent: Bool,
        copyFailed: Bool
    ) -> WatchAodDisplay {
        // The platform's own end-of-session flow owns the screen first: a Save
        // prompt, the saved ack, or sending the last audio are not "content".
        if offeringSave || pendingSync || savedAck || draining || drainFailed {
            return WatchAodDisplay(kind: .platform, active: listening || paused, copyFailed: copyFailed)
        }
        // A live session is exactly the state whose content must stay readable:
        // while listening, while paused, and after the session ended but its last
        // copy is still on screen. Note `active` is deliberately false after the
        // session ends — the timer/chip would otherwise imply it is still running.
        if (listening || paused || hasContent), hasContent {
            return WatchAodDisplay(kind: .content, active: listening || paused, copyFailed: copyFailed)
        }
        // Ready, or a finished session with nothing to read: black, as before.
        return WatchAodDisplay(kind: .idle, active: false, copyFailed: copyFailed)
    }
}
