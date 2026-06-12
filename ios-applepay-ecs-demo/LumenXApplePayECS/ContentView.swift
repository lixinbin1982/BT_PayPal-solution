import SwiftUI
import PassKit

struct ContentView: View {
    @StateObject private var console = APIConsole()
    @StateObject private var manager: ApplePayECSManager
    @State private var mode: Mode = .mock
    @State private var product: StoreAPI.Product?

    enum Mode: String, CaseIterable, Identifiable {
        case mock = "Mock (simulate API calls)"
        case real = "Real Apple Pay sheet"
        var id: String { rawValue }
    }

    init() {
        let c = APIConsole()
        _console = StateObject(wrappedValue: c)
        _manager = StateObject(wrappedValue: ApplePayECSManager(console: c))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            productCard
            controls
            Divider()
            ConsoleView(console: console)
        }
        .task {
            let list = (try? await StoreAPI.products()) ?? []
            product = list.first { $0.id == "baton-4-pro" } ?? list.first
        }
    }

    private var header: some View {
        HStack {
            (Text("LUMEN").bold() + Text("X").bold().foregroundColor(.yellow))
                .font(.title3)
            Text("SANDBOX")
                .font(.caption2.bold())
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Color.yellow.opacity(0.2))
                .clipShape(Capsule())
            Spacer()
            Text("Apple Pay ECS · BT SDK v7")
                .font(.caption2).foregroundColor(.secondary)
        }
        .padding(.horizontal).padding(.vertical, 10)
        .background(Color(.systemGray6))
    }

    private var productCard: some View {
        HStack(spacing: 14) {
            Image(systemName: "flashlight.on.fill")
                .font(.system(size: 36))
                .foregroundColor(.yellow)
                .frame(width: 64, height: 64)
                .background(Color(.systemGray5))
                .cornerRadius(12)
            VStack(alignment: .leading, spacing: 3) {
                Text(product?.name ?? "Baton 4 Pro").font(.headline)
                Text(product?.tagline ?? "Compact tactical flashlight")
                    .font(.caption).foregroundColor(.secondary)
                Text(product.map { String(format: "$%.2f", $0.price) } ?? "—")
                    .font(.subheadline.bold())
            }
            Spacer()
        }
        .padding(.horizontal).padding(.vertical, 10)
    }

    private var controls: some View {
        VStack(spacing: 10) {
            Picker("Mode", selection: $mode) {
                ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            ApplePayButton {
                switch mode {
                case .mock: manager.runMockFlow()
                case .real: manager.runRealFlow()
                }
            }
            .frame(height: 46)
            .opacity(manager.busy ? 0.5 : 1)
            .disabled(manager.busy)

            if let r = manager.result {
                Text(r)
                    .font(.caption)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(r.hasPrefix("✅") ? Color.green.opacity(0.12)
                                                 : Color.red.opacity(0.12))
                    .cornerRadius(8)
            }
        }
        .padding(.horizontal).padding(.bottom, 10)
    }
}

/// Official PassKit Apple Pay button (renders correctly in the simulator).
struct ApplePayButton: UIViewRepresentable {
    let action: () -> Void

    func makeUIView(context: Context) -> PKPaymentButton {
        let b = PKPaymentButton(paymentButtonType: .checkout, paymentButtonStyle: .black)
        b.cornerRadius = 23
        b.addTarget(context.coordinator, action: #selector(Coordinator.tap), for: .touchUpInside)
        return b
    }

    func updateUIView(_ uiView: PKPaymentButton, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(action: action) }

    final class Coordinator {
        let action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func tap() { action() }
    }
}
