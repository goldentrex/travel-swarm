import SwiftUI

// MARK: - Nexus Swarm trade-off quiz (DEBUG ONLY)
//
// Step 1 of the 2-phase flow: `POST /mission/assess` returned trade-off
// questions, and this view walks the traveler through them ONE AT A TIME —
// one question per step (two option buttons), a step indicator, and a
// Continue button that advances the step and finally submits the answers
// via `SwarmViewModel.submitAnswers()`. The question/option text arrives
// already localized from the backend; only the static chrome here is
// translated via `AppSettings.tr`. Wrapped in `#if DEBUG` like the rest of
// the swarm surface.

struct TradeoffQuizView: View {
    @Environment(AppSettings.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss

    var model: SwarmViewModel

    /// The question on screen right now (nil-guarded: an empty quiz never
    /// reaches this view — the VM resolves immediately instead).
    private var currentQuestion: SwarmService.TradeoffQuestion? {
        model.tradeoffs.indices.contains(model.quizStep) ? model.tradeoffs[model.quizStep] : nil
    }

    private var isFinalStep: Bool { model.quizStep >= model.tradeoffs.count - 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            quizHeader
            stepIndicator
            if let question = currentQuestion {
                questionCard(question)
                    .id(model.quizStep)   // drives the step transition
                    .transition(reduceMotion
                                ? .opacity
                                : .asymmetric(
                                    insertion: .move(edge: .trailing)
                                        .combined(with: .opacity)
                                        .combined(with: .scale(scale: 0.96, anchor: .trailing)),
                                    removal: .move(edge: .leading)
                                        .combined(with: .opacity)))
            }
            continueButton
            // Mid-quiz escape hatch — abandons the mission server-side
            // (best-effort), resets back to monitoring and dismisses the
            // sheet so no empty block is left behind.
            Button {
                Haptics.tap()
                model.cancelMission()
                dismiss()
            } label: {
                Label(app.tr("Annuler la mission", "Cancel mission"),
                      systemImage: "xmark.circle")
                    .font(.subheadline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.bordered)
            .tint(Brand.coral)
            .accessibilityIdentifier("trustLayer.cancelMission")
        }
        .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.82),
                   value: model.quizStep)
    }

    // MARK: Header

    private var quizHeader: some View {
        GlassCard(cornerRadius: 18) {
            HStack(spacing: 12) {
                Image(systemName: "questionmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(Brand.gradient)
                VStack(alignment: .leading, spacing: 3) {
                    Text(app.tr("Votre avis est attendu — l'essaim a des questions",
                                "Your input needed — the swarm has questions"))
                        .font(.subheadline.weight(.semibold))
                    Text(app.tr("Répondez à chaque arbitrage et l'essaim adaptera les plans de reprise à vous.",
                                "Answer each trade-off and the swarm will tailor the recovery plans to you."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: Step indicator ("Question 1 of 2" + progress dots)

    private var stepLabel: String {
        String(format: app.trm("Question %1$d sur %2$d",
                               "Question %1$d of %2$d",
                               "Pregunta %1$d de %2$d",
                               "Frage %1$d von %2$d",
                               "第 %1$d 题，共 %2$d 题"),
               model.quizStep + 1, model.tradeoffs.count)
    }

    private var stepIndicator: some View {
        HStack(spacing: 10) {
            Text(stepLabel)
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            Spacer()
            HStack(spacing: 5) {
                ForEach(model.tradeoffs.indices, id: \.self) { index in
                    Capsule()
                        .fill(index == model.quizStep
                              ? AnyShapeStyle(Brand.gradient)
                              : AnyShapeStyle(index < model.quizStep
                                              ? Brand.violet.opacity(0.55)
                                              : Color.secondary.opacity(0.28)))
                        .frame(width: index == model.quizStep ? 18 : 7, height: 7)
                }
            }
            .animation(.snappy(duration: 0.25), value: model.quizStep)
        }
    }

    // MARK: One question step

    private func questionCard(_ question: SwarmService.TradeoffQuestion) -> some View {
        GlassCard(cornerRadius: 20) {
            VStack(alignment: .leading, spacing: 14) {
                Text(question.question)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = question.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                VStack(spacing: 10) {
                    ForEach(Array(question.options.enumerated()), id: \.element.id) { optionIndex, option in
                        optionButton(questionIndex: model.quizStep,
                                     optionIndex: optionIndex,
                                     question: question,
                                     option: option)
                    }
                }
            }
        }
        // `.accessibilityIdentifier` on a CONTAINER propagates to every
        // descendant, so without this the card stamped
        // "trustLayer.quiz.question.N" over each option button and
        // `trustLayer.quiz.option.N.M` did not exist at all — the options
        // rendered fine but were unreachable by identifier. `.contain` keeps
        // the card an enclosing element and leaves the children their own.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trustLayer.quiz.question.\(model.quizStep)")
    }

    private func optionButton(questionIndex: Int, optionIndex: Int,
                              question: SwarmService.TradeoffQuestion,
                              option: SwarmService.TradeoffOption) -> some View {
        let selected = model.answers[question.id] == option.id
        return Button {
            Haptics.tap()
            model.answers[question.id] = option.id
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? AnyShapeStyle(Brand.gradient)
                                              : AnyShapeStyle(Color.secondary.opacity(0.5)))
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.label)
                        .font(.subheadline.weight(selected ? .semibold : .regular))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = option.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((selected ? Brand.violet.opacity(0.14) : Color.white.opacity(0.05)),
                        in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14)
                .strokeBorder(selected ? AnyShapeStyle(Brand.violet.opacity(0.7))
                                       : AnyShapeStyle(Color.white.opacity(0.14)),
                              lineWidth: selected ? 1.5 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("trustLayer.quiz.option.\(questionIndex).\(optionIndex)")
        .animation(.easeOut(duration: 0.18), value: selected)
    }

    // MARK: Back / Continue

    private var continueButton: some View {
        HStack(spacing: 10) {
            if model.quizStep > 0 {
                Button {
                    Haptics.tap()
                    model.quizStep -= 1
                } label: {
                    Label(app.tr("Retour", "Back"), systemImage: "arrow.left")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.bordered)
                .tint(Brand.violet)
                .accessibilityIdentifier("trustLayer.quiz.back")
            }
            Button {
                if isFinalStep {
                    Task { await model.submitAnswers() }
                } else {
                    Haptics.tap()
                    model.quizStep += 1
                }
            } label: {
                Label(app.tr("Continuer", "Continue"),
                      systemImage: isFinalStep ? "paperplane.fill" : "arrow.right")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(Brand.indigo)
            .accessibilityIdentifier("trustLayer.quiz.continue")
            .disabled(!model.currentStepAnswered)
        }
    }
}
