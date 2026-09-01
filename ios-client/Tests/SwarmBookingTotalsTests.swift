//
//  SwarmBookingTotalsTests.swift
//  GlobePlannerTests
//
//  The money rule behind the swarm's confirm screen.
//
//  This is the number a traveler reads immediately before tapping a button
//  that says "book these for me", so the two ways it can lie are the two
//  things tested hardest: presenting several currencies as if they were one
//  bill, and quietly leaving rows out of the total.
//

import Testing
@testable import GlobePlanner

@Suite("Swarm booking totals")
struct SwarmBookingTotalsTests {
    /// Deterministic stand-in for `FX`: 1 EUR = 160 JPY = 1.1 USD. Injecting it
    /// keeps the assertions about the RULE, not about today's live rates.
    private func rate(_ amount: Double, _ from: String, _ to: String) -> Double {
        let perEur = ["EUR": 1.0, "JPY": 160.0, "USD": 1.1]
        guard let f = perEur[from], let t = perEur[to] else { return amount }
        return amount / f * t
    }

    private func row(_ amount: Double?, _ currency: String?, live: Bool)
        -> SwarmBookingTotals.Input {
        .init(amount: amount, currency: currency, isLive: live)
    }

    @Test("one purchase reads as ONE total, whatever the providers answered in")
    func convertsEverythingIntoTheDisplayCurrency() {
        // The real Tokyo shape: Booking.com answers JPY (it ignores the
        // requested currency), Viator answers USD, the trip estimates in EUR.
        let total = SwarmBookingTotals.compute(
            [row(16_000, "JPY", live: true), row(11, "USD", live: true), row(50, "EUR", live: false)],
            display: "EUR",
            convert: rate,
        )
        #expect(total.currency == "EUR")
        #expect(abs(total.live - 110) < 0.01) // 16000 JPY = 100 € + 11 USD = 10 €
        #expect(abs(total.estimated - 50) < 0.01)
        // The traveler is told a rate was applied rather than shown a converted
        // figure as though a provider had quoted it.
        #expect(total.converted)
    }

    @Test("no conversion claimed when every row is already in the display currency")
    func doesNotClaimAConversionItDidNotMake() {
        let total = SwarmBookingTotals.compute(
            [row(40, "EUR", live: true), row(60, "eur", live: false)],
            display: "EUR",
            convert: rate,
        )
        #expect(!total.converted) // case-insensitive: "eur" is not a conversion
        #expect(total.live == 40)
        #expect(total.estimated == 60)
    }

    @Test("a quote and an estimate never merge into one number")
    func keepsQuotesAndEstimatesApart() {
        let total = SwarmBookingTotals.compute(
            [row(100, "EUR", live: true), row(30, "EUR", live: false)],
            display: "EUR",
            convert: rate,
        )
        #expect(total.live == 100)
        #expect(total.estimated == 30)
    }

    @Test("rows with no price are COUNTED, never silently dropped")
    func countsUnpricedRows() {
        // Ericeira, live 2026-09-01: Viator had no listing for 8 of 9 surf
        // activities. Those rows carry no price at all — and a total that
        // omitted them without saying so would read as the whole bill.
        let total = SwarmBookingTotals.compute(
            [row(90, "EUR", live: true), row(nil, "EUR", live: false), row(25, nil, live: false)],
            display: "EUR",
            convert: rate,
        )
        #expect(total.live == 90)
        #expect(total.estimated == 0)
        // An amount with no currency is just as unusable as no amount.
        #expect(total.unpriced == 2)
    }

    @Test("an empty sheet totals zero rather than reporting a phantom charge")
    func emptyIsZero() {
        let total = SwarmBookingTotals.compute([], display: "EUR", convert: rate)
        #expect(total.live == 0)
        #expect(total.estimated == 0)
        #expect(total.unpriced == 0)
        #expect(!total.converted)
    }
}

@Suite("Swarm preview location")
struct SwarmPreviewLocationTests {
    // Live on 2026-09-01: the sheet sent the day's `place` as the search
    // location. On the Florence trip those are "Historic Centre", "Uffizi &
    // Oltrarno", "Oltrarno & San Marco" — districts, which Viator cannot
    // resolve, so all seven activities fell back to the trip's own estimate.
    // The identical titles searched against "Florence, Italy" returned real
    // listings for every one of them.

    @Test("a district falls back to the trip's city")
    func districtFallsBackToTheCity() {
        #expect(SwarmPreviewLocation.city(dayPlace: "Historic Centre",
                                          destination: "Florence, Italy") == "Florence")
        #expect(SwarmPreviewLocation.city(dayPlace: "Uffizi & Oltrarno",
                                          destination: "Florence, Italy") == "Florence")
        #expect(SwarmPreviewLocation.city(dayPlace: "Shinjuku",
                                          destination: "Tokyo, Japan") == "Tokyo")
    }

    @Test("a day in a city the trip actually names keeps that city")
    func multiCityKeepsItsOwnDay() {
        // Losing per-day precision on a genuine multi-city trip would be the
        // opposite mistake: an Osaka day searched against Kyoto.
        #expect(SwarmPreviewLocation.city(dayPlace: "Osaka",
                                          destination: "Kyoto · Osaka · Tokyo, Japan") == "Osaka")
        #expect(SwarmPreviewLocation.city(dayPlace: "Lyon",
                                          destination: "Paris / Lyon, France") == "Lyon")
    }

    @Test("no day place at all still yields the trip's city")
    func missingPlaceStillResolves() {
        #expect(SwarmPreviewLocation.city(dayPlace: nil, destination: "Barcelona, Spain") == "Barcelona")
        #expect(SwarmPreviewLocation.city(dayPlace: "  ", destination: "Barcelona, Spain") == "Barcelona")
    }

    @Test("matching is case-insensitive, as trip titles are not normalised")
    func matchIsCaseInsensitive() {
        #expect(SwarmPreviewLocation.city(dayPlace: "osaka",
                                          destination: "Kyoto · Osaka, Japan") == "osaka")
    }
}

@Suite("Swarm bookable window")
struct SwarmBookableWindowTests {
    // Live on 2026-09-01 against the May-2026 Amsterdam trip: every row of a
    // trip that had already happened offered "Mark 8 items as booked", each one
    // reading "the live rate could not be checked just now" — a transient-
    // sounding excuse for something that can never succeed.

    @Test("a day that has gone by is past")
    func pastDayIsPast() {
        #expect(SwarmBookableWindow.isPast("2026-05-12", today: "2026-09-01"))
        #expect(SwarmBookableWindow.isPast("2026-08-31T09:00:00Z", today: "2026-09-01"))
    }

    @Test("today is not past — a same-day booking is the normal case")
    func todayIsNotPast() {
        #expect(!SwarmBookableWindow.isPast("2026-09-01", today: "2026-09-01"))
        #expect(!SwarmBookableWindow.isPast("2026-09-01T23:59:00Z", today: "2026-09-01"))
    }

    @Test("a future day is kept")
    func futureIsKept() {
        #expect(!SwarmBookableWindow.isPast("2026-09-02", today: "2026-09-01"))
        #expect(!SwarmBookableWindow.isPast("2027-01-01", today: "2026-09-01"))
    }

    @Test("an unreadable date is KEPT, never silently dropped")
    func unreadableIsKept() {
        // Dropping a row we merely failed to parse would hide real work from
        // the traveler — the opposite failure to the one this rule fixes.
        #expect(!SwarmBookableWindow.isPast(nil, today: "2026-09-01"))
        #expect(!SwarmBookableWindow.isPast("", today: "2026-09-01"))
        #expect(!SwarmBookableWindow.isPast("soon", today: "2026-09-01"))
        #expect(!SwarmBookableWindow.isPast("12/05/2026", today: "2026-09-01"))
    }

    @Test("todayISO is a plain ISO day, comparable as a string")
    func todayIsIso() {
        let today = SwarmBookableWindow.todayISO()
        #expect(today.count == 10)
        #expect(today.split(separator: "-").count == 3)
    }
}
