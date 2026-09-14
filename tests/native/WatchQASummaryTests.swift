import Foundation

/// Committed tests for the Live Q&A reading rules (issue #218).
///
/// Run by `scripts/test-watch-replay.sh` through `WatchReplayTests.main()`, so
/// they share that runner's `check`/`eq` failure path (stderr + non-zero exit);
/// there is deliberately no second runner. They cover the two pure decisions the
/// Watch Q&A page is built on: `WatchQASummary.compact(from:)` and
/// `WatchQAPage.display`/`toggle`.
enum WatchQASummaryTests {

    static func run() {
        shortAnswersStayWhole()
        longAnswersKeepTheirPoints()
        conditionsSurvive()
        ambiguousMarkersDoNotOverFire()
        brokenInputIsSafe()
        readingNeverJumpsAnOpenCard()
        print("Watch Q&A summary: short answers, budget, condition coverage, broken input and reading rules passed")
    }

    // MARK: - helpers

    private static func summary(_ answer: String) -> String {
        WatchQASummary.compact(from: answer).text
    }

    /// Like the shared `eq`, but with a message: this file compares a lot of
    /// near-miss text, so a failure has to say which rule broke.
    private static func qaEq<T: Equatable>(
        _ got: T, _ want: T, _ message: String, file: String = #file, line: Int = #line
    ) {
        if got != want {
            fputs("FAIL: \(file):\(line) \(message) — got \(got) want \(want)\n", stderr)
            exit(1)
        }
    }

    /// The #218 rule, asserted the way it matters: the clause is in the summary,
    /// and it is the answer's own sentence copied whole (never rewritten or cut).
    private static func kept(_ answer: String, _ clause: String, _ label: String) {
        let text = summary(answer)
        check(answer.contains(clause), "\(label): the fixture really contains the clause")
        check(text.contains(clause), "\(label): the clause survives the summary — got: \(text)")
    }

    private static func dropped(_ answer: String, _ clause: String, _ label: String) {
        let text = summary(answer)
        check(!text.contains(clause), "\(label): the non-critical clause is left to the full text — got: \(text)")
    }

    /// A long, entirely non-critical sentence, so a following sentence only
    /// survives the budget if it is treated as meaning-critical.
    private static let latinFiller =
        "This sentence is pure background about how the team runs its weekly meetings and it contains nothing that changes the plan at all."
    private static let cjkFiller =
        "这一段只是补充说明把前面的背景再展开一遍不包含别的信息。"

    /// Latin sentences must be space-separated: the splitter only ends a sentence
    /// at a period followed by a break, so "…at all.If…" would stay one sentence
    /// (the same rule that keeps "3.5" whole).
    private static func latin(_ parts: String...) -> String {
        parts.joined(separator: " ")
    }

    /// CJK sentences need no separator: `。` always ends one.
    private static func cjk(_ parts: String...) -> String {
        parts.joined()
    }

    // MARK: - short answers

    private static func shortAnswersStayWhole() {
        let zh = "会议改到下午三点。"
        let zhOut = WatchQASummary.compact(from: zh)
        qaEq(zhOut.text, zh, "a one-sentence Chinese answer is shown whole")
        check(!zhOut.hasMore, "a short Chinese answer hides nothing")

        let en = "The meeting moved to 3pm."
        let enOut = WatchQASummary.compact(from: en)
        qaEq(enOut.text, en, "a one-sentence English answer is shown whole")
        check(!enOut.hasMore, "a short English answer hides nothing")

        // The card never grows a "one conclusion + two bullets" shape of its own.
        check(!zhOut.text.contains("•") && !zhOut.text.contains("\n") && !zhOut.text.contains("- "),
              "the summary invents no bullets or breaks")
    }

    // MARK: - long answers

    private static func longAnswersKeepTheirPoints() {
        let zh = cjk(
            "上线计划已经排好，整体分三个阶段推进，节奏比上一轮紧一些。",
            cjkFiller,
            "如果周五的回归通过，就按原计划下周一上线。",
            "风险是测试资源这周比较紧张，需要提前协调。"
        )
        let zhOut = WatchQASummary.compact(from: zh)
        check(zhOut.hasMore, "a long Chinese answer offers the full text")
        check(zhOut.text.hasPrefix("上线计划已经排好"), "the head sentence leads the summary")
        kept(zh, "如果周五的回归通过，就按原计划下周一上线。", "long zh condition")
        dropped(zh, cjkFiller, "long zh filler")

        let en = latin(
            "The plan has three phases and the pace is tighter than last round.",
            latinFiller,
            "If the Friday regression passes, we ship on Monday as planned.",
            "The test team is short-staffed this week, so they need advance notice."
        )
        let enOut = WatchQASummary.compact(from: en)
        check(enOut.hasMore, "a long English answer offers the full text")
        check(enOut.text.hasPrefix("The plan has three phases"), "the head sentence leads the summary")
        kept(en, "If the Friday regression passes, we ship on Monday as planned.", "long en condition")
        dropped(en, latinFiller, "long en filler")
    }

    // MARK: - condition coverage (the adversarial-review defect)

    /// The two examples from the pre-merge review, verbatim, plus every
    /// subordinate-clause introducer named in it. A keyword whitelist that misses
    /// any of these silently loses the clause that changes the answer's meaning,
    /// which is the one thing #218 forbids.
    private static func conditionsSurvive() {
        let ex1 = latin(
            "You can start the session now.",
            "When the phone disconnects, the recording stops and the file is kept on the watch.",
            "Reconnect later to upload it."
        )
        kept(ex1, "When the phone disconnects, the recording stops and the file is kept on the watch.",
             "reviewer example 1 (when)")
        dropped(ex1, "Reconnect later to upload it.", "reviewer example 1 tail")

        let ex2 = latin(
            "Here is the plan for the week.",
            "In case the server is down, the app falls back to the local cache.",
            "Provided the token is still valid, the sync runs at midnight."
        )
        kept(ex2, "In case the server is down, the app falls back to the local cache.", "reviewer example 2 (in case)")
        kept(ex2, "Provided the token is still valid, the sync runs at midnight.", "reviewer example 2 (provided)")

        // Each introducer in a sentence the budget would otherwise drop.
        let latinIntroducers: [String] = [
            "When the phone disconnects, the recording stops and the file stays on the watch.",
            "Whenever the queue fills, the bridge drops the oldest frame and keeps the newer ones.",
            "While the build is running, the cache stays warm and the dashboard keeps updating.",
            "Unless the token is refreshed, the upload stops and the file waits on the phone.",
            "Until the review is signed off, the release stays frozen for everyone on the team.",
            "In case the server is down, the app falls back to the local cache and retries later.",
            "Provided the token is still valid, the sync runs at midnight and reports back.",
            "Providing the build passes, the release goes out on Friday morning as planned.",
            "As long as the watch stays reachable, the audio keeps flowing to the phone.",
            "Assuming the numbers hold, the second phase starts right after the first one ends.",
            "Suppose the review slips, the launch moves to the next window and nothing else changes.",
            "Subject to approval, the schedule moves forward and the team starts the next phase.",
            "Only if the token is valid does the sync run at midnight on the server side.",
            "Otherwise the app keeps the cache and waits for the next connection attempt.",
            "Depending on the volume, the schedule may move and the team adjusts the plan.",
            "In the event the server is down, the app falls back to the local cache again.",
        ]
        for sentence in latinIntroducers {
            kept(latin("Here is the plan for the week.", latinFiller, sentence),
                 sentence, "latin introducer \(sentence.prefix(16))")
        }

        let cjkIntroducers: [String] = [
            "当手机断开的时候，录音会停止，文件会留在手表上。",
            "在服务器不可用的情况下，应用会回退到本地缓存继续工作。",
            "一旦令牌过期，同步就会停在午夜之前不再继续。",
            "只要手表还能连上手机，音频就会继续送过去。",
            "除非回归全部通过，发布才会按原定时间进行。",
            "否则应用会保留本地缓存并等待下一次连接。",
            "前提是评审能在周一之前签掉，排期才不会整体后移。",
            "具体日期取决于测试资源的多少和审核的排期。",
            "但是设计稿还有两处没定，所以日期还要再往后挪。",
            "至少要把回归用例跑完，才能进入发布流程。",
            "必须先协调好测试资源，才能按原计划推进。",
        ]
        for sentence in cjkIntroducers {
            kept(cjk("本周的计划大概是这样，先按顺序说完再讨论细节。", cjkFiller, sentence),
                 sentence, "cjk marker \(sentence.prefix(10))")
        }
    }

    /// The safe direction is over-keeping, but a neutral sentence in the same
    /// position must still be left for the full text — otherwise the "compact"
    /// card would just be the whole answer.
    private static func ambiguousMarkersDoNotOverFire() {
        let neutralEn = "The dashboard shows the usual numbers and nothing here changes today."
        dropped(latin("Here is the plan for the week.", latinFiller, neutralEn), neutralEn, "neutral en control")

        let neutralZh = "仪表盘显示的还是平常那些数字，今天没有什么变化。"
        dropped(cjk("本周的计划大概是这样，先按顺序说完再讨论细节。", cjkFiller, neutralZh), neutralZh, "neutral zh control")

        // "but" inside a word, and a bare "case", are not introducers.
        let button = "The button on the watch face waits for a tap from the user."
        dropped(latin("Here is the plan for the week.", latinFiller, button), button, "no substring match on 'but'")
        let suitcase = "The suitcase is packed and the calendar is clear for the trip."
        dropped(latin("Here is the plan for the week.", latinFiller, suitcase), suitcase, "a bare 'case' is not a proviso")
    }

    // MARK: - broken / streaming input

    private static func brokenInputIsSafe() {
        // No sentence terminator at all: never cut, never invent one.
        let noTerminator = "这是一段没有句号的回答需要保留全部内容因为没有可切分的位置"
        qaEq(summary(noTerminator), noTerminator, "an unterminated answer is shown whole")
        check(!WatchQASummary.compact(from: noTerminator).hasMore, "an unterminated answer hides nothing")

        // Newlines end a point; they are not content.
        qaEq(summary("第一点\n第二点\n第三点"), "第一点第二点第三点", "newlines are boundaries, not content")

        // A decimal point is not a sentence end.
        let decimal = "版本号是 3.5，容量 1.2GB 就够。"
        qaEq(summary(decimal), decimal, "a period inside a number does not split")

        // CJK terminators keep their form and take no joining space.
        qaEq(summary("这样可以吗？可以！也可以。"), "这样可以吗？可以！也可以。", "CJK terminators survive")
        qaEq(summary("Is it ok? Yes! Fine."), "Is it ok? Yes! Fine.", "Latin sentences keep a single space")

        // Empty and still-streaming answers: no crash, and an empty summary so the
        // card can never render a previous question's text.
        let empty = WatchQASummary.compact(from: "")
        qaEq(empty.text, "", "an empty answer yields an empty summary")
        check(!empty.hasMore, "an empty answer hides nothing")
        qaEq(summary("   \n  "), "", "a whitespace-only answer yields an empty summary")

        let partial = WatchQASummary.compact(from: "我觉得")
        qaEq(partial.text, "我觉得", "a partial answer is shown as-is")
        check(!partial.hasMore, "a partial answer hides nothing")
    }

    // MARK: - reading rules

    private static func readingNeverJumpsAnOpenCard() {
        let a = WatchQAPage.Card(copyId: "A", question: "问题一", answer: "答案一。")
        let b = WatchQAPage.Card(copyId: "B", question: "问题二", answer: "答案二。")

        let live = WatchQAPage.display(copyId: "A", question: a.question, answer: a.answer, opened: nil, expanded: false)
        qaEq(live.card, a, "the live copy is the card")
        check(!live.newer, "a fresh card has nothing waiting")

        // Tapping opens the card and pins it.
        let opened = WatchQAPage.toggle(live)
        qaEq(opened.opened, a, "a tap pins the open card")
        check(opened.expanded, "a tap opens the full answer")
        let openDisplay = WatchQAPage.display(copyId: "A", question: a.question, answer: a.answer,
                                              opened: opened.opened, expanded: opened.expanded)
        qaEq(openDisplay.card, a, "the open card is still the live one")

        // More text for the SAME question keeps flowing into the open card.
        let grown = WatchQAPage.display(copyId: "A", question: a.question, answer: "答案一，后面又补了一句。",
                                        opened: opened.opened, expanded: opened.expanded)
        qaEq(grown.card?.answer, "答案一，后面又补了一句。", "growth of the same copy stays live in the open card")
        check(!grown.newer, "the same copy is not a new answer")

        // #218: a different question must NOT move the page on its own.
        let interrupted = WatchQAPage.display(copyId: "B", question: b.question, answer: b.answer,
                                              opened: opened.opened, expanded: opened.expanded)
        qaEq(interrupted.card, a, "an arriving question keeps the open card A on screen")
        check(interrupted.newer, "the arriving question is announced as a hint, not a jump")
        check(interrupted.expanded, "the open card stays in the reading state")

        // The hint tap is the only thing that returns to the newest answer.
        let returned = WatchQAPage.toggle(interrupted)
        check(returned.opened == nil && !returned.expanded, "tapping the hint drops the pin")
        let latest = WatchQAPage.display(copyId: "B", question: b.question, answer: b.answer,
                                         opened: returned.opened, expanded: returned.expanded)
        qaEq(latest.card, b, "the page is back on the newest answer")
        check(!latest.newer, "nothing is waiting after the return")

        // Closing an open card also hands the page back.
        let closed = WatchQAPage.toggle(openDisplay)
        check(closed.opened == nil && !closed.expanded, "closing a card unpins it")

        // A cleared or not-yet-arrived copy never draws a stale card.
        let cleared = WatchQAPage.display(copyId: "B", question: "", answer: "", opened: nil, expanded: false)
        check(cleared.card == nil, "a cleared copy draws no card")
        let noId = WatchQAPage.display(copyId: "", question: "问题", answer: "答案", opened: nil, expanded: false)
        let noIdToggled = WatchQAPage.toggle(noId)
        check(noIdToggled.expanded && noIdToggled.opened == nil, "an id-less first frame opens but is not pinned")
    }
}
