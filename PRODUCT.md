# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

FPL managers who want to compare player choices, assemble a legal squad, and understand projected returns across upcoming gameweeks.

## Product Purpose

FPL Manager Stats is an analytics workspace for making data-driven Fantasy Premier League decisions. Success means a manager can move from current data to a defensible squad or transfer decision quickly.

## Positioning

The product combines official FPL data with modeled xPts, fixture context, and decision-support views in one manager-focused workspace.

## Operating Context

Managers scan player tables, fixture difficulty, ownership, availability, and projections before a gameweek deadline. Decision Lab turns that evidence into transfer, lineup, captaincy, and chip recommendations for the connected manager's squad.

## Capabilities and Constraints

- Existing routes are served by a React shell over a legacy dashboard UI.
- Bootstrap data provides players, teams, gameweeks, and official FPL squad metadata.
- Users should be able to select up to 8 gameweeks and see player and team xPts over that horizon.
- Decision Lab critiques the connected squad and provides evidence-led lineup, captaincy, transfer and chip recommendations using projections, expected minutes, availability, fixture context, value, uncertainty and FPL constraints.
- xPts are model projections and should be presented as projections rather than guarantees.
- Recommendations must distinguish modeled evidence from uncertain assumptions and should prefer holding a chip or transfer when the evidence does not clear a meaningful threshold.
- Open: persistence and submission to the official FPL account are not part of this surface unless explicitly added later.

## Evidence on Hand

- Official FPL bootstrap and fixtures APIs are integrated through the existing app backend.
- `/api/xpts-projections` and existing AI Team views expose modeled weekly xPts.
- No new product imagery or testimonial evidence is required for this operational tool.

## Product Principles

- Keep the next decision close to its projected consequence.
- Support scanning and comparison across a chosen gameweek horizon.
- Show uncertainty and constraints without slowing down expert users.

## Accessibility & Inclusion

The web interface should remain keyboard accessible, expose meaningful labels for controls, and remain usable on narrow mobile screens.
