import Foundation

/// The compact answer card the Watch shows for Live Q&A by default (issue #218).
///
/// This is the ONE place the Watch decides what the compact card says. It is a
/// pure function of the answer string that is already on the wrist: no phone
/// call, no model, no prompt, no new sync field and no network round trip. If the
/// product later wants an LLM-written summary, this is the single seam to
/// replace — swap the body of `compact(from:)` for one that reads a summary
/// delivered alongside the answer, and nothing in `WatchRootView` has to change.
///
/// The rules, in the order they matter:
/// - A short answer is shown whole. A one-sentence answer stays one sentence and
///   never grows invented bullets, and the card never forces a
///   "one conclusion + two bullet points" shape.
/// - A longer answer keeps its first sentence, then as many following points as
///   fit the card, plus every clause that carries a condition, an uncertainty, a
///   contrast or a requirement even when it does not fit. Those are the clauses
///   whose removal would change what the answer means; the elaboration is what
///   the card leaves for the full text.
/// - A sentence is never cut mid-way. Nothing here rewrites, joins or reorders
///   words, so a kept clause keeps its exact wording and its meaning.
/// - An empty or still-streaming answer yields an empty summary; the caller shows
///   its own "drafting" state rather than a card from the previous question.
enum WatchQASummary {

    /// Sentence enders that stay attached to the sentence they end. `。！？` are
    /// the CJK forms; `.!?;` and the ASCII newline are handled as well because an
    /// answer mixes scripts and the phone sends both.
    private static let terminators: Set<Character> = ["。", "！", "？", "；", "!", "?", ";"]

    /// Joining two sentences needs no space after these, and none before a CJK
    /// sentence either. Everything else is Latin text and takes a space.
    private static let cjkJoins: Set<Character> = [
        "。", "！", "？", "；", "：", "，", "、", "」", "』", "）", "】", "》",
    ]

    /// Where a card stops feeling compact, as a *weighted* length: a CJK/full-width
    /// glyph costs 2 and everything else costs 1, which roughly tracks the columns
    /// a watch line holds. 80 is about four lines of `.body` on the 41 mm content
    /// width (150 pt, ~9 CJK or ~17 Latin glyphs per line).
    ///
    /// It is used twice: an answer that fits is shown whole, and while building a
    /// longer answer's summary it bounds the points that follow the first
    /// sentence. It is never a clip — the first sentence is shown whole even when
    /// it is longer than this, and a clause that changes the meaning is kept even
    /// when it does not fit, because cutting either would change what it says.
    static let compactBudget = 80

    /// The compact card and whether the full answer holds more.
    struct Compact: Equatable {
        /// What the collapsed card shows.
        let text: String
        /// True when the answer keeps more than `text`, so the card offers the
        /// full text. False for a short answer, for an answer with nothing worth
        /// dropping, and for an empty one.
        let hasMore: Bool
    }

    /// The weighted length of `text` (CJK/full-width glyphs count double).
    static func weight(_ text: String) -> Int {
        text.reduce(0) { $0 + (isWide($1) ? 2 : 1) }
    }

    /// Derive the compact card text from `answer`.
    ///
    /// Pure and total: any input, including empty and whitespace-only, returns
    /// without trapping.
    static func compact(from answer: String) -> Compact {
        let sentences = sentences(in: answer)
        guard !sentences.isEmpty else { return Compact(text: "", hasMore: false) }
        let whole = join(sentences)
        if weight(whole) <= compactBudget {
            return Compact(text: whole, hasMore: false)
        }
        // Keep the head, then the following points while they fit. A clause that
        // changes the meaning is kept even when it does not fit: silently dropping
        // a condition is exactly the failure this rule exists to prevent, and the
        // card still scrolls with the crown.
        var kept: [String] = [sentences[0]]
        var spent = weight(sentences[0])
        for sentence in sentences.dropFirst() {
            let extra = weight(sentence) + (needsSpace(after: kept[kept.count - 1], before: sentence) ? 1 : 0)
            if isMeaningCritical(sentence) {
                kept.append(sentence)
                spent += extra
            } else if spent + extra <= compactBudget {
                kept.append(sentence)
                spent += extra
            }
        }
        let text = join(kept)
        return Compact(text: text, hasMore: text != whole)
    }

    // MARK: - Sentence splitting

    /// Split on `。！？!?;` , a sentence-ending `.` and newlines. The terminator
    /// stays on its sentence so the summary reads exactly like the source.
    private static func sentences(in answer: String) -> [String] {
        let chars = Array(collapseSpaces(answer))
        var out: [String] = []
        var current = ""
        for (index, ch) in chars.enumerated() {
            if ch == "\n" {
                // A line break ends a list point (phone and model both emit one
                // point per line); it is a boundary, not content.
                flush(&out, &current)
                continue
            }
            current.append(ch)
            if terminators.contains(ch) {
                flush(&out, &current)
            } else if ch == "." {
                let next = index + 1 < chars.count ? chars[index + 1] : " "
                let prev = index > 0 ? chars[index - 1] : " "
                // A `.` inside a number or an abbreviation ("3.5", "e.g.") is not
                // a sentence end; only a period before a break or a space is.
                let endsSentence = (next == " " || next == "\n")
                    && !prev.isNumber
                    && !next.isNumber
                if endsSentence { flush(&out, &current) }
            }
        }
        flush(&out, &current)
        return out
    }

    private static func flush(_ out: inout [String], _ current: inout String) {
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { out.append(trimmed) }
        current = ""
    }

    /// Collapse runs of spaces/tabs into one space and normalise line endings,
    /// without touching the words themselves. Paragraph breaks are left as a
    /// single `\n` so the splitter still sees them.
    private static func collapseSpaces(_ text: String) -> String {
        var out = ""
        var pendingSpace = false
        for ch in text {
            if ch == "\r" { continue }
            if ch == " " || ch == "\t" {
                pendingSpace = true
                continue
            }
            if pendingSpace, !out.isEmpty, ch != "\n", out.last != "\n" {
                out.append(" ")
            }
            pendingSpace = false
            out.append(ch)
        }
        return out
    }

    // MARK: - Joining

    private static func join(_ sentences: [String]) -> String {
        var out = ""
        for sentence in sentences {
            if out.isEmpty {
                out = sentence
                continue
            }
            out += (needsSpace(after: out, before: sentence) ? " " : "") + sentence
        }
        return out
    }

    /// Does a space belong between two kept sentences? No after CJK punctuation
    /// and none before a CJK sentence; yes between two Latin ones.
    private static func needsSpace(after previous: String, before next: String) -> Bool {
        if let last = previous.last, cjkJoins.contains(last) || isWide(last) { return false }
        if let first = next.first, isWide(first) { return false }
        return true
    }

    /// CJK ideographs, kana and full-width forms. They are one glyph per em, so
    /// they both skip the joining space and count double in `weight`.
    private static func isWide(_ ch: Character) -> Bool {
        guard let scalar = ch.unicodeScalars.first else { return false }
        switch scalar.value {
        case 0x3000...0x303F, 0x3040...0x30FF, 0x3400...0x4DBF,
             0x4E00...0x9FFF, 0xF900...0xFAFF, 0xFF00...0xFFEF:
            return true
        default:
            return false
        }
    }

    // MARK: - What must survive the summary

    /// Clauses whose loss would change the answer: conditions, uncertainty,
    /// contrast, requirements and explicit list points.
    private static func isMeaningCritical(_ sentence: String) -> Bool {
        containsCJKPhrase(sentence) || containsLatinWord(sentence) || isListPoint(sentence)
    }

    private static let cjkPhrases = [
        // conditions
        "如果", "假如", "假设", "若是", "除非", "否则", "一旦", "要是",
        "只要", "万一", "只有", "除了", "取决于", "前提", "条件",
        // uncertainty
        "可能", "也许", "或许", "大概", "大约", "不确定", "未必", "至少", "最多",
        "预计", "估计", "视情况",
        // contrast / correction
        "但是", "不过", "然而", "而是", "例外", "注意", "风险",
        // requirement
        "需要", "必须", "不能", "应当", "建议", "务必",
        // list points
        "首先", "其次", "另外", "此外", "最后", "其一", "其二", "步骤",
    ]

    /// Latin keywords. Long, unambiguous ones match as a prefix so "depending",
    /// "requirements" and "assumptions" are caught; short ones need word
    /// boundaries so "but" is not found inside "button".
    private static let latinStems = [
        "depend", "requir", "assum", "uncertain", "probabl", "possibl", "condition",
    ]
    private static let latinWords = [
        "if", "unless", "otherwise", "whether", "may", "might", "could", "would",
        "should", "must", "need", "needs", "perhaps", "maybe", "however", "but",
        "except", "only", "note", "risk", "likely", "unlikely", "budget", "deadline",
    ]

    private static func containsCJKPhrase(_ sentence: String) -> Bool {
        cjkPhrases.contains { sentence.contains($0) }
    }

    private static func containsLatinWord(_ sentence: String) -> Bool {
        let lower = sentence.lowercased()
        for stem in latinStems where hasBoundaryPrefix(lower, stem) { return true }
        for word in latinWords where hasWord(lower, word) { return true }
        return false
    }

    /// `stem` at a word start, with any continuation (so "requir" matches
    /// "requires" and "required").
    private static func hasBoundaryPrefix(_ haystack: String, _ stem: String) -> Bool {
        var start = haystack.startIndex
        while let range = haystack.range(of: stem, range: start..<haystack.endIndex) {
            let before = range.lowerBound == haystack.startIndex
                ? nil
                : haystack[haystack.index(before: range.lowerBound)]
            if before.map({ !$0.isLetter && !$0.isNumber }) ?? true { return true }
            start = range.upperBound
        }
        return false
    }

    private static func hasWord(_ haystack: String, _ word: String) -> Bool {
        var start = haystack.startIndex
        while let range = haystack.range(of: word, range: start..<haystack.endIndex) {
            let before = range.lowerBound == haystack.startIndex
                ? nil
                : haystack[haystack.index(before: range.lowerBound)]
            let after = range.upperBound == haystack.endIndex
                ? nil
                : haystack[range.upperBound]
            let beforeOK = before.map { !$0.isLetter && !$0.isNumber } ?? true
            let afterOK = after.map { !$0.isLetter && !$0.isNumber } ?? true
            if beforeOK, afterOK { return true }
            start = range.upperBound
        }
        return false
    }

    private static let bulletMarkers: [Character] = [
        "-", "–", "—", "•", "·", "*", "○", "●", "▪", "‣",
    ]
    private static let numberSeparators: [Character] = [".", "、", ")", "）", "．", ":"]

    /// "- point", "• point", "1. point", "1、point", "1) point", "第一步…".
    private static func isListPoint(_ sentence: String) -> Bool {
        guard let first = sentence.first else { return false }
        if bulletMarkers.contains(first) { return true }
        if first.isNumber {
            var rest = sentence.dropFirst()
            while let head = rest.first, head.isNumber { rest = rest.dropFirst() }
            if let sep = rest.first, numberSeparators.contains(sep) { return true }
        }
        return sentence.hasPrefix("第") && sentence.contains("步")
    }
}
