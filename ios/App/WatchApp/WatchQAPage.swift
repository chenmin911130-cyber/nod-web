import Foundation

/// What the Live Q&A reading page shows, as a pure decision.
///
/// Shaped like `WatchAod`: the view owns only the interaction state and renders
/// this, so the reading rules of issue #218 can be verified without a Watch:
/// - the answer text comes from `WatchQASummary`, never from a second field that
///   could drift from the live copy;
/// - an opened card is pinned, so a question that arrives while it is being read
///   can never replace it on its own; the user is offered a hint instead.
///
/// Nothing here talks to the phone, reads a clock, or mutates state.
enum WatchQAPage {

    /// One question/answer pair as the Watch holds it.
    struct Card: Equatable {
        let copyId: String
        let question: String
        let answer: String
    }

    struct Display: Equatable {
        /// The card to draw; nil means there is nothing yet ("listening").
        let card: Card?
        /// An opened card is on screen while a newer question already exists. The
        /// page must not move until the user taps the hint.
        let newer: Bool
        /// The card shows the full answer rather than the compact summary.
        let expanded: Bool
    }

    /// Resolve what to draw.
    ///
    /// `opened` is the card the user pinned, or nil. It is compared by `copyId`:
    /// more text arriving for the *same* question stays live and keeps flowing
    /// into the open card, while a *different* question is what freezes it.
    static func display(
        copyId: String,
        question: String,
        answer: String,
        opened: Card?,
        expanded: Bool
    ) -> Display {
        if let opened, opened.copyId != copyId {
            return Display(card: opened, newer: true, expanded: expanded)
        }
        guard !question.isEmpty || !answer.isEmpty else {
            return Display(card: nil, newer: false, expanded: false)
        }
        return Display(
            card: Card(copyId: copyId, question: question, answer: answer),
            newer: false,
            expanded: expanded
        )
    }

    /// The state after the user taps the card.
    ///
    /// Closed → open it and pin what is on screen. Open → close it and hand the
    /// page back to the newest answer. That tap is the only thing that moves the
    /// page away from a card being read (#218).
    ///
    /// A card with no id yet cannot be pinned — there would be nothing to return
    /// to — but it still expands, so a first frame that arrives before its id is
    /// readable.
    static func toggle(_ display: Display) -> (opened: Card?, expanded: Bool) {
        if display.expanded { return (nil, false) }
        if let card = display.card, !card.copyId.isEmpty { return (card, true) }
        return (nil, display.card != nil)
    }
}
