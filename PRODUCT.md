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

Managers scan player tables, fixture difficulty, ownership, availability, and projections before a gameweek deadline. A team-building workflow should support both a blank squad and the connected manager's current squad.

## Capabilities and Constraints

- Existing routes are served by a React shell over a legacy dashboard UI.
- Bootstrap data provides players, teams, gameweeks, and official FPL squad metadata.
- The builder must enforce the usual FPL squad constraints: 15 players, position quotas of 2 GKP / 5 DEF / 5 MID / 3 FWD, maximum 3 players per club, and a £100.0m budget.
- Users should be able to select up to 8 gameweeks and see player and team xPts over that horizon.
- Users can import an official FPL squad screenshot. OCR runs locally and detected names must be confirmed before filling the builder because screenshots can be ambiguous.
- A squad advisor critiques each player and provides evidence-led lineup, captaincy, transfer and chip recommendations using projections, expected minutes, availability, fixture context, value, uncertainty and FPL constraints.
- xPts are model projections and should be presented as projections rather than guarantees.
- Recommendations must distinguish modeled evidence from uncertain assumptions and should prefer holding a chip or transfer when the evidence does not clear a meaningful threshold.
- Open: persistence and submission to the official FPL account are not part of this surface unless explicitly added later.

## Evidence on Hand

- Official FPL bootstrap and fixtures APIs are integrated through the existing app backend.
- `/api/xpts-projections` and existing AI Team views expose modeled weekly xPts.
- No new product imagery or testimonial evidence is required for this operational tool.

## Product Principles

- Make legality visible while the squad is being assembled.
- Keep the next decision close to its projected consequence.
- Support scanning and comparison across a chosen gameweek horizon.
- Show uncertainty and constraints without slowing down expert users.

## Accessibility & Inclusion

The web interface should remain keyboard accessible, expose meaningful labels for controls, and remain usable on narrow mobile screens.
