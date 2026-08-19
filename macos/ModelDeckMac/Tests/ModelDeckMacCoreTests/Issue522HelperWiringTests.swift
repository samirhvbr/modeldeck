import Foundation
import Testing
@testable import ModelDeckMacCore

// Issue #522 — the app-side half of per-profile helper wiring: the daemon
// call that repoints one profile's settings + pinned shell env at its own
// Keychain item, and the honest decoding of the state it reports back.
//
// No live daemon, port, Keychain or config is touched: the transport is the
// same canned stub #520 uses, and every identity here is a placeholder.

@Suite("Issue #522 — helper wiring daemon channel")
struct Issue522HelperWiringChannelTests {
    private static let sessionStub = StubTransport.Stub(
        status: 200,
        body: #"{"token":"md522-placeholder-session-token"}"#
    )

    @Test("the migration posts to /api/accounts/:id/client-key-helper and names the consented write")
    func postsToWiringEndpoint() async throws {
        let transport = StubTransport(stubs: [
            Self.sessionStub,
            .init(status: 200, body: #"""
            {"clientKeyHelper":{"accountId":"placeholder-a","mode":"per-profile",
            "service":"cli-proxy-api-client.placeholder-a","stage":"complete","settingsWired":true,
            "shellEnvWired":true,"legacySharedKeyStillAdmitted":true,"complete":true}}
            """#)
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(port: 43287), transport: transport)
        let wiring = try await client.wireClientKeyHelper(accountID: "placeholder-a", configWriteVerified: true)

        #expect(wiring.mode == "per-profile")
        #expect(wiring.service == "cli-proxy-api-client.placeholder-a")
        #expect(wiring.isFullyWired)
        // D6: the shared item and its api-keys entry survive the migration.
        #expect(wiring.legacySharedKeyStillAdmitted)

        let post = try #require(transport.requests.last)
        #expect(post.httpMethod == "POST")
        #expect(post.url?.path == "/api/accounts/placeholder-a/client-key-helper")
        #expect(post.value(forHTTPHeaderField: "x-modeldeck-token") == "md522-placeholder-session-token")
        #expect(post.value(forHTTPHeaderField: "Cookie")?.contains("modeldeck_session=") == true)
        let bodyData = try #require(post.httpBody)
        let body = try #require(String(data: bodyData, encoding: .utf8))
        #expect(body.contains("\"configWriteVerified\":true"))
        // The consent fact crosses this boundary; key material never does.
        #expect(!body.lowercased().contains("key\":\""))
    }

    @Test("a daemon that refuses the migration surfaces its status, never a half-truth")
    func refusalPropagates() async throws {
        let transport = StubTransport(stubs: [
            Self.sessionStub,
            .init(status: 409, body: #"{"error":"per-profile client key migration needs the consented config write"}"#)
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(port: 43287), transport: transport)
        // The typed refusal, not merely "something threw": the app has to be
        // able to tell a 409 "do the consented config write first" apart from
        // a transport failure, because only one of them is actionable.
        await #expect(throws: DaemonClientError.daemonError(
            message: "per-profile client key migration needs the consented config write",
            status: 409
        )) {
            _ = try await client.wireClientKeyHelper(accountID: "placeholder-a", configWriteVerified: false)
        }
    }

    @Test("the migration POST is given room for the daemon's global activation lock")
    func migrationPostOutlastsTheActivationLock() async throws {
        let transport = StubTransport(stubs: [
            Self.sessionStub,
            .init(status: 200, body: #"{"clientKeyHelper":{"accountId":"placeholder-a","mode":"per-profile","service":"cli-proxy-api-client.placeholder-a","stage":"complete","settingsWired":true,"shellEnvWired":true,"complete":true}}"#)
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(port: 43287), transport: transport)
        _ = try await client.wireClientKeyHelper(accountID: "placeholder-a", configWriteVerified: true)
        // Another account's renewal can hold the daemon's global Claude
        // activation lock for up to 60s before this write even starts, so the
        // 5s default would abandon a migration the daemon still finishes.
        let post = try #require(transport.requests.last)
        #expect(post.timeoutInterval == 120)
    }

    @Test("wiring state is readable without mutating anything")
    func readsWiringState() async throws {
        let transport = StubTransport(stubs: [
            Self.sessionStub,
            .init(status: 200, body: #"""
            {"clientKeyHelper":{"accountId":"placeholder-a","mode":"legacy",
            "service":"cli-proxy-api-client","settingsWired":true,"shellEnvWired":true,
            "legacySharedKeyStillAdmitted":false,"complete":false}}
            """#)
        ])
        let client = DaemonClient(configuration: DaemonConfiguration(port: 43287), transport: transport)
        let wiring = try await client.clientKeyHelperWiring(accountID: "placeholder-a")
        #expect(wiring.mode == "legacy")
        #expect(!wiring.isFullyWired)
        #expect(try #require(transport.requests.last).httpMethod == "GET")
    }
}

/// TRIPWIRE (never-compromise #4): a migration that stopped between its two
/// files must never render as finished. `complete` is a claim; `settingsWired`
/// and `shellEnvWired` are the evidence, and the evidence wins. If this test
/// is ever relaxed, the UI can tell a user their profile is on its own key
/// while their terminals are still fetching the shared one.
@Suite("TRIPWIRE #522 partial-migration-is-never-complete")
struct Issue522PartialStateTripwireTests {
    @Test("settings written but the shell env not is reported as unfinished, with the truth stated")
    func partialMigrationIsHonest() {
        let partial = ClientKeyHelperWiring(
            accountId: "placeholder-a",
            mode: "per-profile",
            service: "cli-proxy-api-client.placeholder-a",
            stage: "settings",
            settingsWired: true,
            shellEnvWired: false,
            legacySharedKeyStillAdmitted: true,
            complete: false
        )
        #expect(!partial.isFullyWired)
        let description = try? #require(partial.partialStateDescription)
        #expect(description?.contains("still needs to be refreshed") == true)
    }

    @Test("a complete flag cannot outrun the evidence behind it")
    func completeFlagIsNotTrustedAlone() {
        let lying = ClientKeyHelperWiring(
            accountId: "placeholder-a",
            mode: "per-profile",
            service: "cli-proxy-api-client.placeholder-a",
            stage: "complete",
            settingsWired: false,
            shellEnvWired: true,
            complete: true
        )
        #expect(!lying.isFullyWired)
        #expect(lying.partialStateDescription == "This profile is not wired to its own key yet.")
    }

    @Test("an inactive profile's absent shell-env evidence is not read as a failure")
    func inactiveProfileHasNoShellEnvVerdict() {
        let inactive = ClientKeyHelperWiring(
            accountId: "placeholder-a",
            mode: "per-profile",
            service: "cli-proxy-api-client.placeholder-a",
            stage: "complete",
            settingsWired: true,
            shellEnvWired: nil,
            complete: true
        )
        #expect(inactive.isFullyWired)
        #expect(inactive.partialStateDescription == nil)
    }

    @Test("a pre-#522 daemon's empty answer decodes as the legacy shared item")
    func olderDaemonDecodesAsLegacy() throws {
        let wiring = try JSONDecoder().decode(ClientKeyHelperWiring.self, from: Data("{}".utf8))
        #expect(wiring.mode == "legacy")
        #expect(wiring.service == KeychainClientKeyStore.legacySharedService)
        #expect(wiring.stage == nil)
        #expect(wiring.shellEnvWired == nil)
        #expect(!wiring.complete)
        // A garbage-typed payload degrades the same way rather than throwing.
        let hostile = try JSONDecoder().decode(
            ClientKeyHelperWiring.self,
            from: Data(#"{"mode":7,"complete":"yes","shellEnvWired":[1]}"#.utf8)
        )
        #expect(hostile.mode == "legacy")
        #expect(!hostile.complete)
        #expect(hostile.shellEnvWired == nil)
    }
}
