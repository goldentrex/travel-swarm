import SwiftUI

// MARK: - "Book everything with Swarm" — the trust layer
//
// A screen that asks someone to commit has to be honest about three things,
// and the previous version was honest about none of them:
//
//   1. WHAT IT COSTS. It showed the planner's estimate, which is a guess. This
//      one asks Booking.com and Viator what they actually charge, and labels
//      every figure with where it came from — a real quote is badged with the
//      provider, an estimate says so.
//   2. WHAT THE SWARM CANNOT DO. It silently sorted rows by category and said
//      "Swarm has handled everything" above things it cannot touch. This one
//      has a section for exactly that, with the reason on each row.
//   3. WHAT CONFIRMING MEANS. No provider is asked to sell anything and no
//      payment exists: confirming records the reservation in the traveler's own
//      trip. The disclaimer says so, above the button, not buried.

/// One row as the sheet shows it: the trip's own line, plus whatever the
/// provider said about it.
private struct PricedLine: Identifiable {
    let bookable: BookingChecklist.Bookable
    var preview: SwarmService.PreviewLine?

    var id: String { bookable.id }
    var isLive: Bool { preview?.isLive == true }

    /// The trip's own figure for this line. An itinerary item carries it in
    /// `source`; a transit leg carries it on the leg itself — reading only the
    /// first left every flight in the sheet with no price at all.
    var plannedCost: Cost? {
        switch bookable.source {
        case let .item(_, _, _, cost): return cost
        case let .transit(leg): return leg.price
        }
    }

    /// The amount to show: a provider quote when we have one, else the trip's
    /// own estimate, else nothing at all — never a zero standing in for unknown.
    var amount: Double? {
        if let live = preview?.price, isLive { return live }
        return plannedCost?.amount
    }

    var currency: String? {
        if isLive { return preview?.currency }
        return plannedCost?.currency
    }
}


/// The confirm screen's money rule, lifted out of the view so it can be tested.
///
/// One purchase must read as ONE total. Live quotes are requested in the
/// traveler's currency, but a provider may answer in its own (Booking.com
/// prices a Tokyo stay in JPY whatever `filter_by_currency` asks for) and item
/// estimates keep the local currency the timeline shows. Everything is
/// converted into the display currency; rows with no price at all are counted
/// rather than dropped, because a total that silently omits rows reads as the
/// whole bill.
enum SwarmBookingTotals {
    struct Input {
        let amount: Double?
        let currency: String?
        let isLive: Bool
    }

    struct Total {
        let currency: String
        let live: Double
        let estimated: Double
        /// At least one row needed an FX rate — the card says so out loud.
        let converted: Bool
        /// Rows with no price anywhere. NOT part of `live`/`estimated`.
        let unpriced: Int
    }

    /// `convert` maps (amount, from, to) → amount. Injected so the rule can be
    /// tested against known rates instead of whatever the live FX cache holds.
    static func compute(_ rows: [Input], display: String,
                        convert: (Double, String, String) -> Double) -> Total {
        let target = display.uppercased()
        var live = 0.0
        var estimated = 0.0
        var converted = false
        var unpriced = 0
        for row in rows {
            guard let amount = row.amount, let currency = row.currency else {
                unpriced += 1
                continue
            }
            let code = currency.uppercased()
            let value: Double
            if code == target {
                value = amount
            } else {
                value = convert(amount, code, target)
                converted = true
            }
            if row.isLive { live += value } else { estimated += value }
        }
        return Total(currency: target, live: live, estimated: estimated,
                     converted: converted, unpriced: unpriced)
    }
}



/// Whether a row still lies ahead of the traveler.
///
/// A trip whose dates have gone by cannot be "booked": Booking.com rejects a
/// past check-in, Viator has no availability to quote, and offering to record
/// a reservation for a stay that already happened is a trap, not a feature.
/// Rows are compared on the DAY, so an activity earlier today still counts as
/// bookable — a traveler acting on the same day is the normal case.
enum SwarmBookableWindow {
    /// `date` is an ISO date (or ISO timestamp); anything unparseable is kept,
    /// since dropping a row we simply failed to read would hide real work.
    static func isPast(_ date: String?, today: String) -> Bool {
        guard let date, date.count >= 10 else { return false }
        let day = String(date.prefix(10))
        guard day.count == 10, day.contains("-") else { return false }
        return day < today
    }

    /// Today as an ISO day, in the traveler's own calendar.
    static func todayISO(_ now: Date = Date()) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: now)
    }
}

/// Which place name to hand the activity provider for one day.
///
/// A trip's per-day `place` is usually a NEIGHBOURHOOD ("Historic Centre",
/// "Uffizi & Oltrarno", "Shinjuku"), not a city. Viator resolves destinations,
/// so sending a neighbourhood matched nothing and every activity in the sheet
/// fell back to the trip's own estimate — while the very same titles searched
/// against "Florence, Italy" returned real listings for all seven of them.
///
/// So: use the day's own place only when the trip itself names it as one of
/// its destinations (a real multi-city trip: "Kyoto · Osaka · Tokyo" on an
/// Osaka day), and otherwise fall back to the trip's lead city.
enum SwarmPreviewLocation {
    static func city(dayPlace: String?, destination: String) -> String {
        let lead = TripDetailView.leadCity(destination)
        guard let place = dayPlace?.trimmingCharacters(in: .whitespaces), !place.isEmpty else {
            return lead
        }
        // Named by the trip ⇒ it is a city, not a district within one.
        if destination.range(of: place, options: .caseInsensitive) != nil {
            return TripDetailView.leadCity(place)
        }
        return lead
    }
}

struct SwarmBookingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppSettings.self) private var app

    let rawContent: [String: Any]
    let tripId: String?
    let onUpdate: (([String: Any]) -> Void)?

    /// Derived ONCE in `init`: `BookingChecklist.derive` walks the whole trip
    /// and `body` reads these lists several times per render.
    private let swarmRows: [BookingChecklist.Bookable]
    private let travelerRows: [BookingChecklist.Bookable]
    /// Nothing to show because the trip has GONE, not because it is all booked.
    /// Telling a traveler "everything is already booked" about a trip they
    /// came home from is the kind of small lie that costs trust.
    private let everythingIsBehindUs: Bool
    private let content: TripContent?

    @State private var priced: [String: SwarmService.PreviewLine] = [:]
    @State private var loadingPrices = true
    @State private var providersUsed: [String] = []
    @State private var priceCheckFailed = false
    @State private var saving = false
    @State private var errorMsg: String?

    init(content: TripContent?,
         rawContent: [String: Any],
         tripId: String?,
         onUpdate: (([String: Any]) -> Void)?) {
        self.content = content
        self.rawContent = rawContent
        self.tripId = tripId
        self.onUpdate = onUpdate
        let today = SwarmBookableWindow.todayISO()
        var droppedAsPast = 0
        let open = (content.map { BookingChecklist.derive(from: $0) } ?? [])
            .filter { !$0.booked && $0.style.needsBooking }
            // A date that has gone by can never be priced or usefully booked;
            // showing it would put "the live rate could not be checked just
            // now" under every row of a trip that already happened.
            .filter { row in
                let when: String?
                switch row.source {
                case let .item(dayIndex, _, _, _): when = content?.itinerary?[safe: dayIndex]?.date
                case .transit: when = row.departDate
                }
                if SwarmBookableWindow.isPast(when, today: today) {
                    droppedAsPast += 1
                    return false
                }
                return true
            }
        // What the swarm can record is real inventory someone sells. A table,
        // a walk-in and a pass-covered ride are not — and saying so is the
        // point of the second section.
        self.swarmRows = open.filter { ["transport", "stay", "activity"].contains($0.category) }
        self.travelerRows = open.filter { !["transport", "stay", "activity"].contains($0.category) }
        self.everythingIsBehindUs = open.isEmpty && droppedAsPast > 0
    }

    // MARK: Derived rows

    private var swarmPriced: [PricedLine] {
        swarmRows.map { PricedLine(bookable: $0, preview: priced[$0.id]) }
    }
    private var travelerPriced: [PricedLine] {
        travelerRows.map { PricedLine(bookable: $0, preview: priced[$0.id]) }
    }

    /// The sheet's ONE total, in the traveler's own currency.
    /// The rule itself lives in `SwarmBookingTotals` so it is unit-tested.
    private var totals: SwarmBookingTotals.Total {
        SwarmBookingTotals.compute(
            swarmPriced.map { .init(amount: $0.amount, currency: $0.currency, isLive: $0.isLive) },
            display: FX.displayCurrency.uppercased(),
            convert: { amount, from, to in FX.convert(FX.toEur(amount, from: from), to: to) },
        )
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    disclaimer

                    if swarmRows.isEmpty {
                        ContentUnavailableView(
                            everythingIsBehindUs
                                ? app.tr("Ce voyage est passé", "This trip is behind you")
                                : travelerRows.isEmpty
                                    ? app.tr("Rien à réserver", "Nothing left to book")
                                    : app.tr("Rien que le swarm puisse prendre",
                                             "Nothing for Swarm to take on"),
                            systemImage: everythingIsBehindUs ? "clock.badge.checkmark" : "checkmark.seal.fill",
                            description: Text(everythingIsBehindUs
                                ? app.tr("Ses dates sont écoulées — il n'y a plus rien à réserver.",
                                         "Its dates have gone by — there is nothing left to book.")
                                : travelerRows.isEmpty
                                    ? app.tr("Tout est déjà réservé.", "Everything is already booked.")
                                    : app.tr("Il ne reste que ce que vous devez réserver vous-même.",
                                             "Only what you book yourself is left."))
                        )
                    } else {
                        section(title: app.tr("Le swarm enregistre ceci",
                                              "Swarm will record these"),
                                rows: swarmPriced)
                        totalsCard
                    }

                    if !travelerRows.isEmpty {
                        section(title: app.tr("À vous de réserver", "You book these yourself"),
                                rows: travelerPriced,
                                footnote: app.tr(
                                    "Le swarm ne peut pas les prendre : personne ne les vend via une API.",
                                    "Swarm cannot take these on — nobody sells them through an API."))
                    }
                }
                .padding(.vertical)
            }
            .navigationTitle(app.tr("Réserver avec le swarm", "Book with Swarm"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(app.tr("Annuler", "Cancel")) { dismiss() }.disabled(saving)
                }
            }
            .safeAreaInset(edge: .bottom) { confirmBar }
            .task { await loadPrices() }
        }
    }

    // MARK: Pieces

    private var disclaimer: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(app.tr("Prix réels, réservation simulée", "Real prices, simulated booking"),
                  systemImage: "info.circle.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Brand.indigo)
            Text(app.tr(
                "Les prix et disponibilités affichés viennent de Booking.com et Viator. Confirmer marque ces éléments comme réservés dans VOTRE voyage — aucune réservation n'est faite auprès des fournisseurs et aucun paiement n'est effectué.",
                "Prices and availability come from Booking.com and Viator. Confirming marks these as booked in YOUR trip — no reservation is made with the providers and no payment is taken."))
                .font(.caption)
                .foregroundStyle(.secondary)
            if priceCheckFailed {
                Label(app.tr("Les prix réels n'ont pas pu être vérifiés — tout est affiché en estimation.",
                             "Live prices could not be checked — everything below is an estimate."),
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Brand.indigo.opacity(0.08), in: .rect(cornerRadius: 12))
        .padding(.horizontal)
    }

    private func section(title: String,
                         rows: [PricedLine],
                         footnote: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline).padding(.horizontal)
            VStack(spacing: 0) {
                ForEach(rows) { row in
                    lineRow(row)
                    if row.id != rows.last?.id { Divider().padding(.leading, 48) }
                }
            }
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal)
            if let footnote {
                Text(footnote).font(.caption).foregroundStyle(.secondary).padding(.horizontal)
            }
        }
    }

    private func lineRow(_ row: PricedLine) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: row.bookable.icon)
                .foregroundStyle(Brand.indigo)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.preview?.matchedName ?? row.bookable.title)
                    .font(.subheadline.weight(.medium))
                // When the provider matched a DIFFERENT product than the plan
                // named, show both — the traveler is approving the real one.
                if let matched = row.preview?.matchedName, matched != row.bookable.title {
                    Text(app.tr("prévu : ", "planned: ") + row.bookable.title)
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                Text(row.bookable.whenLabel).font(.caption).foregroundStyle(.secondary)
                priceBadge(row)
            }
            Spacer(minLength: 8)
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 16)
    }

    @ViewBuilder
    private func priceBadge(_ row: PricedLine) -> some View {
        if loadingPrices && row.preview == nil {
            Text(app.tr("recherche du prix…", "checking the price…"))
                .font(.caption2).foregroundStyle(.tertiary)
        } else if let amount = row.amount, let currency = row.currency {
            HStack(spacing: 6) {
                Text(SwarmFormat.money(amount, currency: currency))
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                if row.isLive, let provider = row.preview?.provider {
                    Text(provider)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Brand.indigo.opacity(0.14), in: Capsule())
                        .foregroundStyle(Brand.indigo)
                } else {
                    // An estimate must never look like a quote.
                    Text(app.tr("estimation", "estimate"))
                        .font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.14), in: Capsule())
                        .foregroundStyle(.secondary)
                }
            }
        } else if let reason = row.preview?.unavailableReason {
            Text(reason).font(.caption2).foregroundStyle(.tertiary)
        }
    }

    private var totalsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            let total = totals
            if total.live > 0 {
                totalRow(app.tr("Prix réels", "Real prices"),
                         SwarmFormat.money(total.live, currency: total.currency), strong: true)
            }
            if total.estimated > 0 {
                totalRow(app.tr("Encore estimé", "Still estimated"),
                         SwarmFormat.money(total.estimated, currency: total.currency), strong: false)
            }
            if total.unpriced > 0 {
                // The single most important line on this card: without it the
                // traveler reads the total as the whole bill.
                totalRow(app.tr("Sans prix", "No price yet"),
                         app.tr("\(total.unpriced) élément\(total.unpriced > 1 ? "s" : "")",
                                "\(total.unpriced) item\(total.unpriced > 1 ? "s" : "")"),
                         strong: false)
                Text(app.tr("Ces éléments ne sont pas compris dans le total.",
                            "These items are not included in the total."))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            if total.converted {
                // Say it rather than quietly presenting a converted figure as
                // the price a provider quoted.
                Text(app.tr("Converti en \(total.currency) au taux du jour.",
                            "Converted to \(total.currency) at today's rate."))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            if !providersUsed.isEmpty {
                Text(app.tr("Source : ", "Source: ") + providersUsed.joined(separator: ", "))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground),
                    in: .rect(cornerRadius: 12))
        .padding(.horizontal)
    }

    private func totalRow(_ label: String, _ value: String, strong: Bool) -> some View {
        HStack {
            Text(label).font(.subheadline).foregroundStyle(strong ? .primary : .secondary)
            Spacer()
            Text(value)
                .font(strong ? .headline : .subheadline)
                .monospacedDigit()
                .foregroundStyle(strong ? .primary : .secondary)
        }
    }

    private var confirmBar: some View {
        VStack(spacing: 8) {
            if let errorMsg {
                Text(errorMsg).font(.caption).foregroundStyle(.red)
                    .multilineTextAlignment(.center).padding(.horizontal)
            }
            Button {
                Task { await confirm() }
            } label: {
                if saving {
                    ProgressView().tint(.white).frame(maxWidth: .infinity)
                } else {
                    Text(app.tr("Marquer \(swarmRows.count) éléments comme réservés",
                                "Mark \(swarmRows.count) items as booked"))
                        .font(.headline).frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(Brand.indigo)
            .controlSize(.large)
            .disabled(saving || swarmRows.isEmpty)
            .padding(.horizontal)
            .padding(.bottom)
        }
        .background(.regularMaterial)
    }

    // MARK: Work

    /// Ask the swarm what these rows really cost. A failure here is not fatal:
    /// the sheet keeps the trip's own estimates, clearly labelled as such.
    private func loadPrices() async {
        guard let tripId, !swarmRows.isEmpty else {
            loadingPrices = false
            return
        }
        defer { loadingPrices = false }
        let payload = swarmRows.map { previewPayload(for: $0) }
        do {
            let preview = try await SwarmService.bookingPreview(
                tripId: tripId, lines: payload, quoteCurrency: FX.displayCurrency.uppercased())
            // `uniqueKeysWithValues` TRAPS on a duplicate key. The ids are
            // the server's echo of what we sent, so a repeated one would
            // crash a sheet the traveler opened on purpose — keep the first
            // answer for an id instead of dying over a malformed response.
            priced = Dictionary(preview.lines.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            providersUsed = preview.providersUsed
        } catch {
            // NOT silent: every row is about to be badged "estimate", and the
            // traveler deserves to know that is because the check failed — not
            // because the providers had nothing to say.
            priceCheckFailed = true
        }
    }

    /// One row as the server wants it. Stays carry their real check-in and
    /// night count so the quote is for the nights actually planned.
    private func previewPayload(for row: BookingChecklist.Bookable) -> [String: Any] {
        var payload: [String: Any] = [
            "id": row.id,
            "kind": row.category == "transport" ? "transport" : row.category,
            "title": row.title,
        ]
        if case let .item(_, _, _, cost) = row.source, let cost {
            payload["estimate"] = cost.amount
            payload["currency"] = cost.currency
        }
        if case let .item(dayIndex, _, _, _) = row.source {
            let day = content?.itinerary?[safe: dayIndex]
            // The provider needs a CITY it can resolve, not the day's district.
            let destination = content?.destination?.text ?? ""
            let city = SwarmPreviewLocation.city(dayPlace: day?.place?.en ?? day?.place?.text,
                                                 destination: destination)
            if !city.isEmpty { payload["city"] = city }
            if let date = day?.date, !date.isEmpty {
                payload["date"] = date
                if row.category == "stay" { payload["checkIn"] = date }
            }
            if row.category == "stay" {
                payload["nights"] = max(1, row.groupMembers.count)
                payload["guests"] = max(1, content?.travelers?.count ?? 2)
            }
        }
        return payload
    }

    private func confirm() async {
        saving = true
        errorMsg = nil
        defer { saving = false }

        var (updated, applied) = MarkBookedService.applyBulkBooking(rawContent, for: swarmRows)
        guard applied > 0 else {
            errorMsg = app.tr("Ces éléments ont changé — rouvre le voyage et réessaie.",
                              "These items have changed — reopen the trip and try again.")
            Haptics.warning()
            return
        }
        // Write the REAL price back, not the estimate we started from: the
        // budget, the settlement panel and the Sharecount all read these lines,
        // and leaving a guess behind would undo the whole point of the sheet.
        updated = applyLivePrices(to: updated)

        if let tripId {
            do {
                try await MarkBookedService.persist(tripId: tripId, content: updated)
            } catch let conflict as MarkBookedService.ConflictError {
                onUpdate?(conflict.serverContent)
                errorMsg = app.tr("Modifié sur un autre appareil — réessaie.",
                                  "Changed on another device — try again.")
                Haptics.warning()
                return
            } catch {
                errorMsg = app.tr("Impossible d'enregistrer. Réessaie.",
                                  "Couldn't save. Try again.")
                Haptics.warning()
                return
            }
        }
        onUpdate?(updated)
        Haptics.success()
        dismiss()
    }

    /// Overwrite each confirmed line's cost with the provider's real figure.
    /// Only genuinely live quotes are written — an estimate is already what the
    /// trip holds, and rewriting it with itself would only add noise.
    private func applyLivePrices(to content: [String: Any]) -> [String: Any] {
        var updated = content
        for row in swarmRows {
            guard let preview = priced[row.id], preview.isLive,
                  let amount = preview.price, let currency = preview.currency,
                  case let .item(dayIndex, itemIndex, _, _) = row.source,
                  var itinerary = updated["itinerary"] as? [[String: Any]],
                  itinerary.indices.contains(dayIndex),
                  var items = itinerary[dayIndex]["items"] as? [[String: Any]],
                  items.indices.contains(itemIndex)
            else { continue }
            items[itemIndex]["cost"] = ["amount": amount, "currency": currency]
            itinerary[dayIndex]["items"] = items
            updated["itinerary"] = itinerary
        }
        return updated
    }
}
