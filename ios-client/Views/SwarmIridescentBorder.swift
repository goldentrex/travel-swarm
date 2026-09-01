//
//  SwarmIridescentBorder.swift
//  GlobePlanner
//
//  Lives in the DESIGN SYSTEM, not in the swarm feature, because GlassCard
//  renders it (GlassComponents.swift, behind the `isSwarmActive` environment
//  key). It used to be declared inside NexusSwarmView.swift, which pointed the
//  dependency the wrong way round: the design system referenced a type owned by
//  the feature, so deleting the swarm files would have failed to compile 18
//  GlassCard call sites across the app.
//
//  Nothing about the drawing is swarm-specific — only the environment key that
//  switches it on is. Withdrawing the feature is a server flag (`SWARM_ENABLED`,
//  read through SwarmAvailability); removing the code is now also possible.
//

import SwiftUI

/// Apple-Intelligence-style rotating conic border. The rotation MEANS
/// "the swarm is thinking", so it runs only while agents are actually working
/// (`processing` / `resolving` — see `SwarmViewModel.isThinking`), never while
/// standing by or while a finished proposal waits on the traveler. `settled`
/// (and a selected-but-idle plan page) renders a STATIC `Brand.gradient`
/// stroke; everything else a quiet hairline (SPEC §5.5). Perf: capped at
/// 20 fps via `minimumInterval`, paused when inactive, static under Reduce
/// Motion.
/// Referenced from TrustLayerSheet — keep internal visibility.
struct SwarmIridescentBorder: View {
    var active: Bool
    var settled: Bool
    var cornerRadius: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if active && !reduceMotion {
                // 20 fps, not 30: the ring turns 90°/s, so a frame every
                // 50 ms is still 4.5° apart — visually identical, a third
                // less work. This overlay sits on content inside a
                // ScrollView, so its layer spans the WHOLE scrollable height
                // (a tall plan page is easily 2000 pt); every frame redraws
                // all of it, which is what made the Trust Layer crawl.
                TimelineView(.animation(minimumInterval: 1.0 / 20.0, paused: !active)) { context in
                    let angle = context.date.timeIntervalSinceReferenceDate
                        .remainder(dividingBy: 4) / 4 * 360
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .strokeBorder(
                            AngularGradient(
                                colors: [
                                    Color(red: 0.95, green: 0.25, blue: 0.8),  // Magenta
                                    Color(red: 0.35, green: 0.8, blue: 1.0),   // Cyan
                                    Color(red: 0.95, green: 0.65, blue: 0.2),  // Orange/Yellow
                                    Color(red: 0.6, green: 0.2, blue: 0.95),   // Purple
                                    Color(red: 0.95, green: 0.25, blue: 0.8)   // Magenta (wrap)
                                ],
                                center: .center,
                                angle: .degrees(angle)
                            ),
                            lineWidth: 2
                        )
                }
            } else if active {
                // Reduce Motion — one static frame of the gradient ring.
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(
                        AngularGradient(
                            colors: [
                                Color(red: 0.95, green: 0.25, blue: 0.8),
                                Color(red: 0.35, green: 0.8, blue: 1.0),
                                Color(red: 0.95, green: 0.65, blue: 0.2),
                                Color(red: 0.6, green: 0.2, blue: 0.95),
                                Color(red: 0.95, green: 0.25, blue: 0.8)
                            ],
                            center: .center,
                            angle: .degrees(30)
                        ),
                        lineWidth: 2
                    )
            } else {
                RoundedRectangle(cornerRadius: cornerRadius)
                    // `Color.separator`, not white-on-alpha: this hairline is
                    // the only edge an unselected plan card has, and at 14 %
                    // white it simply did not exist on a light background.
                    .strokeBorder(settled ? AnyShapeStyle(Brand.gradient)
                                          : AnyShapeStyle(Color(.separator)),
                                  lineWidth: settled ? 2 : 1)
            }
        }
        .allowsHitTesting(false)
    }
}
