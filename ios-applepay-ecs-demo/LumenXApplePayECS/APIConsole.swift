import Foundation
import SwiftUI

/// In-app API console — mirrors the web demo's 📜 API Console. Every call in
/// the ECS sequence is logged with its source→destination and address state.
final class APIConsole: ObservableObject {
    enum AddressState {
        case none      // no buyer address involved
        case redacted  // zip/city/state/country only (pre-authorization)
        case full      // complete address available
        case response  // return value

        var color: Color {
            switch self {
            case .none: return .primary
            case .redacted: return .orange
            case .full: return .green
            case .response: return .secondary
            }
        }
    }

    struct Entry: Identifiable {
        let id = UUID()
        let step: String
        let route: String   // e.g. "App → BT SDK"
        let name: String    // API name
        let detail: String
        let state: AddressState
        let time = Date()
    }

    @Published private(set) var entries: [Entry] = []

    func log(_ step: String, _ route: String, _ name: String,
             _ detail: String = "", state: AddressState = .none) {
        DispatchQueue.main.async {
            self.entries.append(Entry(step: step, route: route, name: name,
                                      detail: detail, state: state))
        }
        mirrorToServer(step: step, route: route, name: name, detail: detail)
    }

    /// Mirror app-side steps to the demo server's /api/logs/client so the web
    /// store's 📜 API Console shows the full mobile ECS sequence too.
    private func mirrorToServer(step: String, route: String, name: String, detail: String) {
        guard Config.mirrorLogsToServer else { return }
        let parts = route.components(separatedBy: " → ")
        let body: [String: Any] = [
            "method": "iOS",
            "path": "step \(step): \(name)",
            "via": "BT iOS SDK v7 (LumenX demo app)",
            "from": parts.first ?? "iOS App",
            "to": parts.count > 1 ? parts[1] : "(client-side)",
            "request": detail.isEmpty ? nil : ["detail": detail],
            "status": 200
        ].compactMapValues { $0 }
        var req = URLRequest(url: Config.serverBase.appendingPathComponent("/api/logs/client"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req).resume() // fire-and-forget
    }

    func clear() {
        DispatchQueue.main.async { self.entries.removeAll() }
    }
}

struct ConsoleView: View {
    @ObservedObject var console: APIConsole

    var body: some View {
        ScrollViewReader { proxy in
            List(console.entries) { e in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(e.step)
                            .font(.caption2.bold())
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.15))
                            .clipShape(Capsule())
                        Text(e.route).font(.caption2).foregroundColor(.secondary)
                        Spacer()
                        Text(e.time, style: .time).font(.caption2).foregroundColor(.secondary)
                    }
                    Text(e.name)
                        .font(.caption.monospaced().bold())
                        .foregroundColor(e.state.color)
                    if !e.detail.isEmpty {
                        Text(e.detail)
                            .font(.caption2.monospaced())
                            .foregroundColor(e.state.color.opacity(0.85))
                    }
                }
                .id(e.id)
                .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
            }
            .listStyle(.plain)
            .onChange(of: console.entries.count) { _ in
                if let last = console.entries.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }
}
