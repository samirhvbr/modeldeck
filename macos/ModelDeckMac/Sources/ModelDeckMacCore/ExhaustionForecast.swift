import Foundation

/// `GET /api/usage/exhaustion-forecast` (issue #497) — the daemon's
/// reset-aware time-to-dry estimate, one entry per enabled account plus the
/// pool's worst case.
///
/// Decision 0034: the app reads this from the daemon API only; it never
/// derives a dry time from live harness state. Decision 0019: provider
/// percentages are ground truth, the dry time is an ESTIMATE — the payload
/// carries `estimateLabel` and its fixed `basisWindow`, and every surface
/// that renders a dry time must carry that label through (see
/// `ExhaustionForecastPresentation`).
///
/// Decoding is deliberately tolerant (the house pattern): an older daemon
/// without the endpoint fails the request outright, and a daemon that omits
/// individual blocks decodes them to nil rather than failing the whole read.
public struct ExhaustionForecast: Codable, Equatable, Sendable {
    /// The fixed evidence window the estimate is computed over ("trailing 24
    /// hours"), surfaced in tooltips so the estimate states its own basis.
    public struct BasisWindow: Codable, Equatable, Sendable {
        public var source: String?
        public var label: String?
        public var since: String?
        public var until: String?
        public var hours: Double?
        public var minimumSpanMinutes: Double?

        public init(
            source: String? = nil,
            label: String? = nil,
            since: String? = nil,
            until: String? = nil,
            hours: Double? = nil,
            minimumSpanMinutes: Double? = nil
        ) {
            self.source = source
            self.label = label
            self.since = since
            self.until = until
            self.hours = hours
            self.minimumSpanMinutes = minimumSpanMinutes
        }
    }

    /// Present when the estimate runs past the account's next reset and the
    /// daemon assumed the measured pace continues into the following window.
    /// A strictly weaker claim than a same-window estimate, so the UI says so.
    public struct Carryover: Codable, Equatable, Sendable {
        public var assumed: Bool?
        public var resetAt: String?
        public var note: String?

        public init(assumed: Bool? = nil, resetAt: String? = nil, note: String? = nil) {
            self.assumed = assumed
            self.resetAt = resetAt
            self.note = note
        }
    }

    public struct Account: Codable, Equatable, Sendable, Identifiable {
        public var accountId: String
        public var accountLabel: String?
        public var provider: String?
        public var scope: String?
        /// "forecast" or "no-forecast". Anything else is treated as no
        /// forecast — an unknown status can never be rendered as a time.
        public var status: String?
        public var dryAt: String?
        public var burnRatePercentPerHour: Double?
        public var resetsAt: String?
        public var carryover: Carryover?
        /// Why there is no forecast (too little evidence, refills first, …).
        public var reason: String?

        public var id: String { accountId }

        public init(
            accountId: String,
            accountLabel: String? = nil,
            provider: String? = nil,
            scope: String? = nil,
            status: String? = nil,
            dryAt: String? = nil,
            burnRatePercentPerHour: Double? = nil,
            resetsAt: String? = nil,
            carryover: Carryover? = nil,
            reason: String? = nil
        ) {
            self.accountId = accountId
            self.accountLabel = accountLabel
            self.provider = provider
            self.scope = scope
            self.status = status
            self.dryAt = dryAt
            self.burnRatePercentPerHour = burnRatePercentPerHour
            self.resetsAt = resetsAt
            self.carryover = carryover
            self.reason = reason
        }
    }

    public struct Pool: Codable, Equatable, Sendable {
        public var status: String?
        public var worstCase: Account?

        public init(status: String? = nil, worstCase: Account? = nil) {
            self.status = status
            self.worstCase = worstCase
        }
    }

    public var estimateLabel: String?
    public var basisWindow: BasisWindow?
    public var accounts: [Account]
    public var pool: Pool?

    public init(
        estimateLabel: String? = nil,
        basisWindow: BasisWindow? = nil,
        accounts: [Account] = [],
        pool: Pool? = nil
    ) {
        self.estimateLabel = estimateLabel
        self.basisWindow = basisWindow
        self.accounts = accounts
        self.pool = pool
    }

    private enum CodingKeys: String, CodingKey {
        case estimateLabel, basisWindow, accounts, pool
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        estimateLabel = try? container.decodeIfPresent(String.self, forKey: .estimateLabel)
        basisWindow = try? container.decodeIfPresent(BasisWindow.self, forKey: .basisWindow)
        accounts = (try? container.decodeIfPresent([Account].self, forKey: .accounts)) ?? []
        pool = try? container.decodeIfPresent(Pool.self, forKey: .pool)
    }

    /// The forecast entry for one account, or nil when the payload doesn't
    /// mention it (a just-added account, a provider-filtered read).
    public func account(id: String) -> Account? {
        accounts.first { $0.accountId == id }
    }

    /// What the deck row renders for this account — nil means the row shows
    /// NOTHING. Never a placeholder, never a guessed time (issue #503).
    public func presentation(
        forAccountID id: String,
        now: Date,
        calendar: Calendar = .current
    ) -> ExhaustionForecastPresentation? {
        ExhaustionForecastPresentation.make(
            account: account(id: id),
            estimateLabel: estimateLabel,
            basis: basisWindow,
            now: now,
            calendar: calendar
        )
    }
}

/// The one compact string a deck row shows for time-to-dry, plus the fuller
/// truth for the hover tooltip and the phrase VoiceOver must hear.
///
/// Minimal-first (grilling ruling 4): the row gets ONE short caption, not a
/// labeled block. Everything else — basis window, measured pace, carryover
/// caveat — lives in the tooltip.
public struct ExhaustionForecastPresentation: Equatable, Sendable {
    /// "Est. dry in 3 hr 10 min" / "Est. dry Wed 6:00 PM". Always carries the
    /// estimate marker inline, per decision 0019.
    public var rowText: String
    /// Hover backstop: the label, its basis window, the measured pace, the
    /// absolute timestamp, and the carryover caveat when one applies.
    public var tooltip: String
    /// The clause folded into the ROW's VoiceOver label. The row button
    /// carries an explicit accessibility label, which suppresses child
    /// elements (the #65/#113/#272 class), so this caption's own text would
    /// otherwise never be spoken.
    public var accessibilityPhrase: String
    /// True when the estimate runs past the next reset and assumes the pace
    /// continues — a weaker claim, said out loud rather than hidden.
    public var assumesCarryover: Bool

    public init(
        rowText: String,
        tooltip: String,
        accessibilityPhrase: String,
        assumesCarryover: Bool
    ) {
        self.rowText = rowText
        self.tooltip = tooltip
        self.accessibilityPhrase = accessibilityPhrase
        self.assumesCarryover = assumesCarryover
    }

    /// Pure derivation so the honesty rules are unit-testable. Returns nil —
    /// the row renders nothing — whenever the daemon has no forecast, the
    /// status is unknown, the timestamp is unparseable, or the estimated
    /// moment has already passed (a stale estimate is not evidence about now).
    public static func make(
        account: ExhaustionForecast.Account?,
        estimateLabel: String?,
        basis: ExhaustionForecast.BasisWindow?,
        now: Date,
        calendar: Calendar = .current
    ) -> ExhaustionForecastPresentation? {
        guard let account, account.status == "forecast" else { return nil }
        guard let dryAt = DeckDateParsing.date(from: account.dryAt) else { return nil }
        let interval = dryAt.timeIntervalSince(now)
        guard interval > 0 else { return nil }

        let when = relativeOrAbsolute(dryAt: dryAt, interval: interval, calendar: calendar)
        let carryover = account.carryover?.assumed == true
        let label = (estimateLabel?.isEmpty == false ? estimateLabel! : "Estimate")

        var tooltipLines = ["\(label) · \(basis?.label ?? "recent usage")"]
        if let absolute = DeckBuilder.absoluteResetText(for: dryAt, calendar: calendar) {
            tooltipLines.append("Runs dry around \(absolute).")
        }
        if let rate = account.burnRatePercentPerHour, rate > 0 {
            tooltipLines.append("Measured pace \(paceText(rate))% per hour.")
        }
        if carryover, let note = account.carryover?.note, !note.isEmpty {
            tooltipLines.append(note)
        }

        return ExhaustionForecastPresentation(
            rowText: "Est. dry \(when.short)",
            tooltip: tooltipLines.joined(separator: "\n"),
            accessibilityPhrase: "estimated to run dry \(when.spoken)"
                + (carryover ? ", assuming the pace continues past the next reset" : ""),
            assumesCarryover: carryover
        )
    }

    /// Same tiering and voice as the row's reset copy (`DeckBuilder.resetText`):
    /// a countdown inside a day, a weekday-and-time inside a week, a bare date
    /// beyond. Local clock, no zone suffix — the tooltip keeps the zone.
    private static func relativeOrAbsolute(
        dryAt: Date,
        interval: TimeInterval,
        calendar: Calendar
    ) -> (short: String, spoken: String) {
        if interval < 3_600 {
            let text = "in \(max(1, Int(interval / 60))) min"
            return (text, text)
        }
        if interval < 86_400 {
            let hours = Int(interval / 3_600)
            let minutes = Int(interval.truncatingRemainder(dividingBy: 3_600) / 60)
            let text = minutes > 0 ? "in \(hours) hr \(minutes) min" : "in \(hours) hr"
            return (text, text)
        }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = calendar.locale
        formatter.dateFormat = interval < 7 * 86_400 ? "EEE h:mm a" : "MMM d"
        let text = formatter.string(from: dryAt)
        return (text, text)
    }

    private static func paceText(_ rate: Double) -> String {
        rate >= 10
            ? String(format: "%.0f", rate)
            : String(format: "%.1f", rate)
    }
}
