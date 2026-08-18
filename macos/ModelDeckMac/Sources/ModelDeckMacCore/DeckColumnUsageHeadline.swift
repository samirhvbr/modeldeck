import Foundation

// Issue #458 — the provider column header answers "how much total runway is
// left across this pool?" without anyone scanning N rows.
//
// Tim's format ruling (recorded on the issue, binding): the headline is a
// PERCENTAGE — the sum of the member rows' "% left" values, in the deck's
// existing "% left" language and treatment. The divided-by-100 form
// ("3.4 left") was considered and lost.
//
// Design amendment (Tim, binding): the header line reads
// "7 subscriptions · 341% left" — the aggregate sits on the RIGHT so it
// lines up with the member rows' "% left" column, and the header's own copy
// says "subscriptions" (the app-wide copy sweep is issue #459, separate).
//
// The feature exists to COMPRESS information, so it costs no new row and no
// new surface: it rides the header line the column already renders.
//
// The decision lives here, pure, so "what does the header claim, and is the
// claim honest" is a unit test rather than a screenshot (house style:
// StatuslineCaptureControl, ProxyCoexistNotice).

/// The aggregate "% left" a provider column's header shows beside its
/// subscription count.
public enum DeckColumnUsageHeadline {
    /// What the header renders, plus the disclosure that keeps a partial sum
    /// from reading as a complete one.
    public struct Display: Equatable, Sendable {
        /// "341% left" — the locked deck convention, same words as a row.
        public var text: String
        /// The summed whole percentage points. Exactly the integers on
        /// screen: rows render `displayedRemainingPercent`, and so does this.
        public var points: Int
        /// How many of the column's accounts the sum actually covers.
        public var countedAccounts: Int
        /// The column's whole roster — the same number
        /// `subscriptionCountText` states, hidden accounts included.
        public var totalAccounts: Int
        /// True only when every account in the roster is in the sum.
        public var isComplete: Bool
        /// Hover copy. When the sum is partial it names the denominator, the
        /// reason, and the direction of the error (the real total is at least
        /// what is shown — never a strict "higher", which omitted data at 0%
        /// left would falsify).
        public var tooltip: String
        public var accessibilityLabel: String

        /// Issue #482: the sum as a share of the counted pool's capacity —
        /// points ÷ (countedAccounts × 100), as a whole percentage. 474
        /// points across 7 counted subscriptions → 68. Equivalently the
        /// mean % left across the counted subscriptions; the denominator is
        /// the COUNTED accounts, matching the sum's own coverage, so a
        /// partial pool never fabricates capacity it didn't measure.
        public var sharePercent: Int {
            guard countedAccounts > 0 else { return 0 }
            return Int((Double(points) / Double(countedAccounts)).rounded())
        }

        /// Issue #488: the header rendered in the pool's chosen format —
        /// same "% left" words in both, the tooltip carries the math.
        public func text(_ format: MenuBarPinResolver.TotalFormat) -> String {
            format == .share ? "\(sharePercent)% left" : text
        }

        /// Issue #488: the share form's hover copy — the sum tooltip's
        /// honesty rules (counted denominator, lower-bound phrasing) with
        /// the share arithmetic spelled out.
        public var shareTooltip: String
        public var shareAccessibilityLabel: String

        public func tooltip(_ format: MenuBarPinResolver.TotalFormat) -> String {
            format == .share ? shareTooltip : tooltip
        }

        public func accessibilityLabel(_ format: MenuBarPinResolver.TotalFormat) -> String {
            format == .share ? shareAccessibilityLabel : accessibilityLabel
        }
    }

    /// The column header's whole aggregate-usage decision.
    ///
    /// An account is **counted** only when it currently displays a "% left"
    /// number and that number is current:
    ///
    /// - No displayed percent (`displayedRemainingPercent == nil`) — a
    ///   spend-headlined card, an idle-rolled window (#175), an account the
    ///   provider reported nothing for — is unknown and stays out. A % is
    ///   never fabricated for it.
    /// - Stale data stays out too: the spec asks for known CURRENT values,
    ///   and a card already rendering "Data from 16 hr ago" (#89) must not
    ///   silently prop up a headline claiming present-tense runway. Staleness
    ///   arrives through `isStale` — the same per-row seam the column view
    ///   already holds — because it is clock-derived and this type is not.
    ///   The daemon's own per-window `stale` flag (#42) counts as well.
    /// - Hidden accounts (#315/#319) are out by necessity: hiding drops the
    ///   row and its data, while `subscriptionCountText` keeps stating the
    ///   full roster. Left unhandled, the header would show a 4-account sum
    ///   beside "7 subscriptions" as if the two agreed.
    ///
    /// Anything left out makes `isComplete` false and shows up in the
    /// tooltip: the issue's hard line is that a partial sum is never
    /// presented as a complete one. With nothing countable there is no
    /// honest number to show, so the header renders no headline at all.
    ///
    /// Mixed plan tiers inside one column are summed unweighted — v1's
    /// explicit ruling, since a token-weighted cross-tier number would be a
    /// guess. The tooltip says so rather than letting the sum imply parity.
    public static func display(
        for column: DeckColumn,
        isStale: (DeckAccountRow) -> Bool = { _ in false }
    ) -> Display? {
        var points = 0
        var counted = 0
        var stale = 0
        var unknown = 0

        for row in column.rows {
            guard let percent = row.displayedRemainingPercent else {
                unknown += 1
                continue
            }
            guard !isStale(row), row.worstWindow?.stale != true else {
                stale += 1
                continue
            }
            points += Int(percent.rounded())
            counted += 1
        }

        guard counted > 0 else { return nil }

        let hidden = max(column.hiddenAccountCount, 0)
        let total = column.rows.count + hidden
        let text = "\(points)% left"
        let isComplete = counted == total

        let share = counted > 0 ? Int((Double(points) / Double(counted)).rounded()) : 0
        return Display(
            text: text,
            points: points,
            countedAccounts: counted,
            totalAccounts: total,
            isComplete: isComplete,
            tooltip: tooltip(
                text: text,
                provider: column.title,
                counted: counted,
                total: total,
                hidden: hidden,
                stale: stale,
                unknown: unknown
            ),
            accessibilityLabel: isComplete
                ? "\(points) percent left across \(subscriptionsPhrase(total))"
                : "\(points) percent left across \(counted) of \(subscriptionsPhrase(total))",
            shareTooltip: shareTooltip(
                share: share,
                points: points,
                provider: column.title,
                counted: counted,
                total: total,
                hidden: hidden,
                stale: stale,
                unknown: unknown
            ),
            shareAccessibilityLabel: isComplete
                ? "\(share) percent of capacity left across \(subscriptionsPhrase(total))"
                : "\(share) percent of capacity left across \(counted) of \(subscriptionsPhrase(total))"
        )
    }

    private static func tooltip(
        text: String,
        provider: String,
        counted: Int,
        total: Int,
        hidden: Int,
        stale: Int,
        unknown: Int
    ) -> String {
        let tiers = "Plan tiers aren't weighted — this adds percentages, not capacity."
        guard counted < total else {
            return "\(text) — the sum of every \(provider) subscription's % left, across \(subscriptionsPhrase(total)). \(tiers)"
        }
        var reasons: [String] = []
        if hidden > 0 { reasons.append("\(hidden) hidden") }
        if stale > 0 { reasons.append("\(stale) with data too old to count") }
        if unknown > 0 { reasons.append("\(unknown) with no current reading") }
        let left = reasons.isEmpty ? "" : " Left out: \(reasons.joined(separator: ", "))."
        // A lower bound, never a strict one: an excluded subscription may
        // itself be sitting at 0% left, in which case the real total EQUALS
        // what's shown. "Higher" would be a claim the omitted data cannot
        // support — the same honesty this whole type exists for.
        return "\(text) — the sum of \(counted) of this column's \(subscriptionsPhrase(total)).\(left)"
            + " The pool's real total is at least this. \(tiers)"
    }

    /// Issue #488: the share form's tooltip — the same coverage honesty as
    /// the sum's, with the capacity arithmetic stated so "61% left" can
    /// never read as one subscription's number.
    private static func shareTooltip(
        share: Int,
        points: Int,
        provider: String,
        counted: Int,
        total: Int,
        hidden: Int,
        stale: Int,
        unknown: Int
    ) -> String {
        let math = "the summed % left (\(points)%) divided by the counted"
            + " \(subscriptionsPhrase(counted))' combined capacity (\(counted * 100)%)."
        let tiers = "Plan tiers aren't weighted — every subscription counts as 100% of capacity."
        guard counted < total else {
            return "\(share)% left — every \(provider) subscription's share of the pool's capacity: \(math) \(tiers)"
        }
        var reasons: [String] = []
        if hidden > 0 { reasons.append("\(hidden) hidden") }
        if stale > 0 { reasons.append("\(stale) with data too old to count") }
        if unknown > 0 { reasons.append("\(unknown) with no current reading") }
        let left = reasons.isEmpty ? "" : " Left out: \(reasons.joined(separator: ", "))."
        return "\(share)% left — \(counted) of this column's \(subscriptionsPhrase(total))"
            + " as a share of their capacity: \(math)\(left) \(tiers)"
    }

    private static func subscriptionsPhrase(_ count: Int) -> String {
        count == 1 ? "1 subscription" : "\(count) subscriptions"
    }
}
