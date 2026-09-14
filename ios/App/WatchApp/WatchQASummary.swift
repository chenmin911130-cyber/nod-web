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
///   the card leaves for the full text. Detection is a broad set of
///   subordinate-clause introducers ("when…", "in case…", "provided…", "as long
///   as…", "如果…", "一旦…", "…的时候", "…时，"), not a short keyword list: missing
///   a form loses the clause, while keeping one only lengthens a scrollable card.
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
    ///
    /// This is deliberately a broad net, because the failure it guards against is
    /// asymmetric: dropping a condition changes what the answer means (which #218
    /// forbids), while keeping one only makes the compact card a little longer,
    /// and the card scrolls. So any subordinate-clause introducer counts, not a
    /// short list of the obvious forms — a "when the phone disconnects…" or
    /// "provided the token is valid…" clause carries as much meaning as an
    /// "if…" clause, and a keyword whitelist that misses it silently loses it.
    private static func isMeaningCritical(_ sentence: String) -> Bool {
        hasCJKMarker(sentence) || hasLatinMarker(sentence) || isListPoint(sentence)
    }

    // MARK: CJK markers

    /// CJK has no word boundaries, so these are plain substrings.
    private static let cjkMarkers = [
        // conditions / provisos
        "如果", "假如", "假设", "假若", "倘若", "若是", "要是", "一旦", "只要",
        "只有", "除非", "否则", "万一", "前提", "取决", "视情况", "情况下",
        "的话", "的时候",
        // uncertainty
        "可能", "也许", "或许", "大概", "大约", "不确定", "未必", "至少", "最多",
        "预计", "估计", "恐怕", "似乎", "看起来",
        // contrast / correction
        "但是", "不过", "然而", "而是", "反而", "例外", "注意", "风险",
        // requirement
        "需要", "必须", "不能", "应当", "应该", "建议", "务必", "一定要", "得先",
    ]

    private static let cjkTimeBreaks = ["时，", "时、", "时；", "时。", "时！", "时？"]

    private static func hasCJKMarker(_ sentence: String) -> Bool {
        if cjkMarkers.contains(where: { sentence.contains($0) }) { return true }
        // "当…时" / "…时，" / "…的时候" — the CJK temporal/conditional clause
        // form, which no single keyword above covers.
        if cjkTimeBreaks.contains(where: { sentence.contains($0) }) { return true }
        return sentence.contains("当") && sentence.contains("时")
    }

    // MARK: Latin markers

    /// Stems, matched at a word start: "assum" covers assume/assuming/assumption,
    /// "conditio" covers condition/conditions/conditional.
    private static let latinStems = [
        "depend", "requir", "assum", "uncertain", "probabl", "possibl",
        "conditio", "expect", "need", "suppos",
    ]

    /// Whole words. "when", "while" and "until" are temporal as often as they are
    /// conditional, but a temporal clause is still meaning-bearing, and over-
    /// keeping is the safe direction.
    private static let latinWords: Set<String> = [
        "if", "when", "whenever", "while", "unless", "until", "provided",
        "providing", "otherwise", "whether", "may", "might", "could", "would",
        "should", "must", "perhaps", "maybe", "however", "but", "except", "only",
        "note", "risk", "likely", "unlikely", "budget", "deadline", "warning",
        "caution", "caveat", "contingency",
    ]

    /// Multi-word introducers, matched as consecutive word tokens so "in case" is
    /// found and a bare "case" is not.
    private static let latinPhrases: [[String]] = [
        ["in", "case"], ["as", "long", "as"], ["as", "soon", "as"],
        ["so", "long", "as"], ["subject", "to"], ["in", "the", "event"],
        ["in", "the", "worst", "case"], ["in", "the", "best", "case"],
        ["at", "least"], ["at", "most"], ["in", "the", "meantime"],
    ]

    private static func hasLatinMarker(_ sentence: String) -> Bool {
        let tokens = words(in: sentence)
        guard !tokens.isEmpty else { return false }
        for token in tokens {
            if latinWords.contains(token) { return true }
            if latinStems.contains(where: { token.hasPrefix($0) }) { return true }
        }
        return latinPhrases.contains { contains(tokens, $0) }
    }

    /// Word tokens: letters, digits and the apostrophe. Matching whole words keeps
    /// "but" out of "button" and "case" alone out of a proviso.
    private static func words(in sentence: String) -> [String] {
        sentence.lowercased()
            .split { !($0.isLetter || $0.isNumber || $0 == "'") }
            .map(String.init)
    }

    private static func contains(_ tokens: [String], _ phrase: [String]) -> Bool {
        guard !phrase.isEmpty, tokens.count >= phrase.count else { return false }
        for start in 0...(tokens.count - phrase.count) where
            Array(tokens[start..<(start + phrase.count)]) == phrase {
            return true
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
