import Foundation
import Testing
@testable import ModelDeckMacCore

/// Issue #503: the #497 exhaustion forecast reaching the deck row.
///
/// The honesty rules are the point of this suite: a row shows a dry time only
/// when the daemon states one, and shows NOTHING otherwise — never a
/// placeholder, never a guess, never an estimate whose moment has passed.
/// Placeholder identities only (repo rule 1); no daemon is contacted.
@Suite("Issue 503 · deck time-to-dry")
struct Issue503DeckTimeToDryTests {
    private static let now = Date(timeIntervalSince1970: 1_800_000_000)

    /// Pinned zone + locale so weekday/time symbols are deterministic
    /// (the #138 convention).
    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        calendar.locale = Locale(identifier: "en_US")
        return calendar
    }

    private func forecast(
        status: String = "forecast",
        dryAt: String? = nil,
        offsetHours: Double? = nil,
        burnRate: Double? = 4.25,
        carryover: ExhaustionForecast.Carryover? = nil,
        reason: String? = nil
    ) -> ExhaustionForecast {
        let iso = ISO8601DateFormatter()
        let dry = dryAt ?? offsetHours.map {
            iso.string(from: Self.now.addingTimeInterval($0 * 3_600))
        }
        return ExhaustionForecast(
            estimateLabel: "Estimate",
            basisWindow: ExhaustionForecast.BasisWindow(
                source: "usage_snapshots",
                label: "trailing 24 hours",
                hours: 24
            ),
            accounts: [
                ExhaustionForecast.Account(
                    accountId: "a1",
                    accountLabel: "Studio",
                    provider: "claude",
                    scope: "week",
                    status: status,
                    dryAt: dry,
                    burnRatePercentPerHour: burnRate,
                    carryover: carryover,
                    reason: reason
                )
            ]
        )
    }

    private func presentation(_ forecast: ExhaustionForecast) -> ExhaustionForecastPresentation? {
        forecast.presentation(forAccountID: "a1", now: Self.now, calendar: Self.calendar)
    }

    // MARK: - Row shows a time only when there is one

    @Test func aForecastWithinTheDayReadsAsACountdown() throws {
        let shown = try #require(presentation(forecast(offsetHours: 3.5)))
        #expect(shown.rowText == "Est. dry in 3 hr 30 min")
        #expect(shown.assumesCarryover == false)
    }

    @Test func aForecastUnderAnHourReadsInMinutes() throws {
        let shown = try #require(presentation(forecast(offsetHours: 0.75)))
        #expect(shown.rowText == "Est. dry in 45 min")
    }

    @Test func aForecastLaterThisWeekReadsAsAWeekdayAndTime() throws {
        let shown = try #require(presentation(forecast(offsetHours: 50)))
        // 2027-01-15 was a Friday in Los Angeles; the row speaks the local
        // clock with no zone suffix (#137), the tooltip keeps the zone.
        #expect(shown.rowText.hasPrefix("Est. dry "))
        #expect(shown.rowText.contains(":"))
        #expect(shown.rowText.contains("M"))  // AM/PM
    }

    @Test func aForecastBeyondAWeekReadsAsABareDate() throws {
        let shown = try #require(presentation(forecast(offsetHours: 24 * 12)))
        #expect(!shown.rowText.contains(":"))
        #expect(shown.rowText.hasPrefix("Est. dry "))
    }

    /// The acceptance criterion: unknown means NOTHING on the row.
    @Test func noForecastRendersNothing() {
        let payload = forecast(
            status: "no-forecast",
            dryAt: nil,
            burnRate: nil,
            reason: "Not enough recent usage to measure a pace."
        )
        #expect(presentation(payload) == nil)
    }

    @Test func anUnknownStatusIsNeverRenderedAsATime() {
        // A future daemon status this build doesn't understand must fall to
        // "no forecast", never to a rendered dryAt.
        #expect(presentation(forecast(status: "provisional", offsetHours: 4)) == nil)
    }

    @Test func anUnparseableTimestampRendersNothing() {
        #expect(presentation(forecast(dryAt: "soon-ish")) == nil)
    }

    @Test func anExpiredEstimateRendersNothingRatherThanAPastTime() {
        // A forecast whose moment already passed is not evidence about now.
        #expect(presentation(forecast(offsetHours: -2)) == nil)
    }

    @Test func aMissingAccountRendersNothing() {
        let payload = forecast(offsetHours: 3)
        #expect(payload.presentation(forAccountID: "not-in-payload", now: Self.now) == nil)
    }

    // MARK: - Decision 0019: the estimate labels itself

    @Test func theRowTextCarriesTheEstimateMarkerAndTheTooltipItsBasis() throws {
        let shown = try #require(presentation(forecast(offsetHours: 6)))
        #expect(shown.rowText.hasPrefix("Est. "))
        #expect(shown.tooltip.contains("Estimate · trailing 24 hours"))
        #expect(shown.tooltip.contains("Measured pace 4.2% per hour."))
        #expect(shown.tooltip.contains("Runs dry around"))
    }

    @Test func aCarryoverEstimateSaysSoInsteadOfHidingIt() throws {
        let shown = try #require(presentation(forecast(
            offsetHours: 30,
            carryover: ExhaustionForecast.Carryover(
                assumed: true,
                resetAt: "2027-01-14T00:00:00.000Z",
                note: "Assumes the measured burn rate carries over after this reset."
            )
        )))
        #expect(shown.assumesCarryover)
        #expect(shown.tooltip.contains("carries over after this reset"))
        #expect(shown.accessibilityPhrase.hasSuffix(
            ", assuming the pace continues past the next reset"
        ))
    }

    // MARK: - Accessibility: the #65/#113/#272 suppression class

    /// The row Button carries an EXPLICIT accessibility label, which
    /// suppresses every child element — so the new caption's text must be
    /// spoken by the parent label or VoiceOver never hears the dry time.
    @Test func theRowLabelSpeaksTheDryTimeBecauseItSuppressesTheCaption() throws {
        let shown = try #require(presentation(forecast(offsetHours: 3.5)))
        let label = row().accessibilityLabel(showsIdentity: false, forecast: shown)
        #expect(label == "Studio, estimated to run dry in 3 hr 30 min")
    }

    /// The negative half of the tripwire: no forecast adds no speech, so the
    /// label can never imply a time the row doesn't show.
    @Test func noForecastAddsNothingToTheRowLabel() {
        #expect(row().accessibilityLabel(showsIdentity: false, forecast: nil) == "Studio")
    }

    /// The forecast clause must stay distinguishable from the reset wording
    /// already in the row — "runs dry" is never "resets".
    @Test func theSpokenClauseNeverImpersonatesAReset() throws {
        let shown = try #require(presentation(forecast(offsetHours: 3.5)))
        #expect(shown.accessibilityPhrase.contains("estimated to run dry"))
        #expect(!shown.accessibilityPhrase.lowercased().contains("reset")
            || shown.assumesCarryover)
    }

    /// The other folded-in states keep speaking: the forecast clause is
    /// appended, never a replacement (#272's weight, #65's duplicate token).
    @Test func theForecastClauseComposesWithTheExistingSpokenStates() throws {
        let shown = try #require(presentation(forecast(offsetHours: 3.5)))
        let label = row(weight: 8).accessibilityLabel(
            showsIdentity: false,
            isMenuBarSource: true,
            forecast: shown
        )
        #expect(label == "Studio, shown in menu bar, proxy routing weight 8, "
            + "estimated to run dry in 3 hr 30 min")
    }

    private func row(weight: Int? = nil) -> DeckAccountRow {
        DeckAccountRow(
            account: DeckAccount(
                id: "a1",
                provider: "claude",
                label: "Studio",
                proxyWeight: weight
            ),
            provider: .claude,
            windows: [],
            isActive: false,
            activationState: .unknown
        )
    }
}

/// Decoding + transport: the payload shape mirrors
/// `exhaustionForecastReport` in src/usage-analytics.mjs (#497).
@Suite("Issue 503 · forecast payload")
struct Issue503ForecastPayloadTests {
    private static let payload = """
    {
      "estimateLabel": "Estimate",
      "basisWindow": {
        "source": "usage_snapshots",
        "label": "trailing 24 hours",
        "since": "2027-01-12T00:00:00.000Z",
        "until": "2027-01-13T00:00:00.000Z",
        "hours": 24,
        "minimumSpanMinutes": 45
      },
      "accounts": [
        {
          "accountId": "a1",
          "accountLabel": "Studio",
          "provider": "claude",
          "scope": "week",
          "status": "forecast",
          "dryAt": "2027-01-13T18:00:00.000Z",
          "burnRatePercentPerHour": 4.25,
          "resetsAt": "2027-01-14T00:00:00.000Z",
          "carryover": null,
          "reason": null
        },
        {
          "accountId": "a2",
          "accountLabel": "Overflow",
          "provider": "codex",
          "scope": null,
          "status": "no-forecast",
          "dryAt": null,
          "burnRatePercentPerHour": null,
          "resetsAt": null,
          "carryover": null,
          "reason": "Not enough recent usage to measure a pace."
        }
      ],
      "pool": {
        "status": "forecast",
        "worstCase": {
          "accountId": "a1",
          "accountLabel": "Studio",
          "status": "forecast",
          "dryAt": "2027-01-13T18:00:00.000Z"
        }
      }
    }
    """

    @Test func theFullPayloadDecodes() throws {
        let report = try JSONDecoder().decode(
            ExhaustionForecast.self, from: Data(Self.payload.utf8)
        )
        #expect(report.estimateLabel == "Estimate")
        #expect(report.basisWindow?.label == "trailing 24 hours")
        #expect(report.accounts.count == 2)
        #expect(report.account(id: "a2")?.status == "no-forecast")
        #expect(report.account(id: "a2")?.reason == "Not enough recent usage to measure a pace.")
        #expect(report.pool?.worstCase?.accountId == "a1")
    }

    /// Tolerant decoding, the house rule: a daemon that omits blocks yields
    /// nils and an empty roster instead of failing the whole read.
    @Test func anOlderShapeDecodesToEmptyRatherThanFailing() throws {
        let report = try JSONDecoder().decode(
            ExhaustionForecast.self, from: Data("{}".utf8)
        )
        #expect(report.accounts.isEmpty)
        #expect(report.pool == nil)
        #expect(report.basisWindow == nil)
        #expect(report.presentation(forAccountID: "a1", now: Date()) == nil)
    }

    @Test func theClientReadsTheForecastEndpoint() async throws {
        let transport = StubTransport(stubs: [.init(status: 200, body: Self.payload)])
        let client = DaemonClient(
            configuration: DaemonConfiguration(port: 65_000),
            transport: transport
        )
        let report = try await client.exhaustionForecast()
        #expect(report.accounts.count == 2)
        #expect(transport.requests.first?.url?.path == "/api/usage/exhaustion-forecast")
    }
}

/// The refresh seam: the forecast rides the deck-state refresh, and a daemon
/// that can't serve it leaves rows with no dry time at all.
@Suite("Issue 503 · forecast refresh")
@MainActor
struct Issue503ForecastRefreshTests {
    private struct StubEvaluatorOnly: UsageEvaluating {
        func evaluateWorstRemaining() async throws -> WorstRemaining? { nil }
    }

    private final class StubForecastProvider: ExhaustionForecastProviding, @unchecked Sendable {
        private let lock = NSLock()
        private var results: [Result<ExhaustionForecast, Error>]
        private(set) var callCount = 0

        init(results: [Result<ExhaustionForecast, Error>]) {
            self.results = results
        }

        func usageExhaustionForecast() async throws -> ExhaustionForecast {
            try next().get()
        }

        private func next() -> Result<ExhaustionForecast, Error> {
            lock.lock()
            defer { lock.unlock() }
            callCount += 1
            guard !results.isEmpty else { return .failure(URLError(.cannotConnectToHost)) }
            return results.removeFirst()
        }
    }

    private func report(dryAt: String?) -> ExhaustionForecast {
        ExhaustionForecast(
            estimateLabel: "Estimate",
            basisWindow: ExhaustionForecast.BasisWindow(label: "trailing 24 hours"),
            accounts: [
                ExhaustionForecast.Account(
                    accountId: "a1",
                    accountLabel: "Studio",
                    status: dryAt == nil ? "no-forecast" : "forecast",
                    dryAt: dryAt
                )
            ]
        )
    }

    private func row() -> DeckAccountRow {
        DeckAccountRow(
            account: DeckAccount(id: "a1", provider: "claude", label: "Studio"),
            provider: .claude,
            windows: [],
            isActive: false,
            activationState: .unknown
        )
    }

    @Test func refreshPublishesTheForecastAndDerivesTheRowLine() async throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let model = MenuBarStatusModel(
            evaluator: StubEvaluatorOnly(),
            forecastProvider: StubForecastProvider(results: [
                .success(report(dryAt: ISO8601DateFormatter().string(
                    from: now.addingTimeInterval(2 * 3_600)
                )))
            ]),
            clock: { now }
        )
        await model.refresh()
        #expect(model.exhaustionForecast?.accounts.count == 1)
        let shown = try #require(model.exhaustionForecast(for: row()))
        #expect(shown.rowText == "Est. dry in 2 hr")
    }

    /// A daemon without the #497 endpoint (or a failed read) leaves rows with
    /// no dry time — the refresh itself still succeeds.
    ///
    /// CodeRabbit (PR #510): starting from nil proved nothing about the
    /// TRANSITION, so a regression that kept serving a stale dry time after a
    /// failed later read would have passed. The sequence is now
    /// success-then-failure, and it asserts the derived row line — not just
    /// the raw payload — goes away.
    @Test func aFailedForecastReadClearsAStaleLineButNotTheRefresh() async throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let model = MenuBarStatusModel(
            evaluator: StubEvaluatorOnly(),
            forecastProvider: StubForecastProvider(results: [
                .success(report(dryAt: ISO8601DateFormatter().string(
                    from: now.addingTimeInterval(2 * 3_600)
                )))
            ]),
            clock: { now }
        )
        await model.refresh()
        #expect(model.exhaustionForecast != nil)
        let shown = try #require(model.exhaustionForecast(for: row()))
        #expect(shown.rowText == "Est. dry in 2 hr")

        // Second refresh: the provider's queue is empty, so the read throws.
        await model.refresh()
        #expect(model.connection == .connected)
        #expect(model.exhaustionForecast == nil)
        #expect(model.exhaustionForecast(for: row()) == nil)
    }

    @Test func noForecastProviderMeansNoLineAndNoCall() async {
        let model = MenuBarStatusModel(evaluator: StubEvaluatorOnly())
        await model.refresh()
        #expect(model.exhaustionForecast == nil)
        #expect(model.exhaustionForecast(for: row()) == nil)
    }
}
