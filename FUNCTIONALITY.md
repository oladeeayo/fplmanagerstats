# FPL Manager Stats - Functionality Documentation

## Overview
FPL Manager Stats is a comprehensive Fantasy Premier League analytics platform that helps managers make data-driven decisions. The site provides advanced analytics, predictions, and insights beyond what the official FPL site offers.

**Live Site:** https://fplmanager.xyz

---

## Navigation Tabs

### 1. General Tab
The landing page with at-a-glance FPL data.

#### Features:
- **FPL Overview** - Current gameweek stats: average score, GW high, GW average, total transfers
- **Most Selected Players** - Top 10 most owned players with photos, ownership %, points, cost, and PPG
- **Team Fixtures** - All 20 PL teams with next 5 gameweek fixtures, FDR (Fixture Difficulty Rating) coloring, and top 3 players by points per team
- **Availability Issues** - Injured, suspended, or unavailable players
- **Transfer Trends** - Top 10 most transferred in/out players
- **Price Changes** - Latest price risers and fallers with ownership data

---

### 2. Manager Tab
Deep analysis of any FPL manager's team and history.

#### Input:
- Manager ID (found in FPL URL: `fantasy.premierleague.com/entry/[MANAGER_ID]/...`)

#### Features:
- **Manager Summary** - Name, team, overall rank, total points, average per GW, best/worst GW, captaincy efficiency, template score
- **Position Summary** - Points breakdown by GKP/DEF/MID/FWD with top scorer per position
- **Squad Performance Table** - All players used this season with: points, GW appearances, starts, captaincy points, value, ownership, PPG
- **Underperforming Players** - Identifies players underperforming based on:
  - Tough fixtures ahead (avg FDR ≥ 3.5)
  - Poor form (< 2.0 pts in last 5)
  - Limited minutes (< 500 total)
  - Yellow card risk (≥ 4 cards)
  - Low PPG (< 2.0)
- **Replacement Suggestions** - Alternative players in same position within price range, sorted by form
- **Charts**:
  - Points Per Gameweek (line chart with gradient)
  - Rank Per Gameweek (reversed Y-axis)
  - Last 3 GWs Performance (horizontal bar chart)
- **Upcoming Fixtures** - Next 5 fixtures for current squad with FDR ratings
- **Captain Analysis** - Every GW captain choice vs best option, missed points calculation
- **Chip Impact** - Points scored with chip vs average, showing if chip was worth it
- **Defensive Record** - Clean sheets, goals conceded, saves, bonus points
- **Previous Season** - Comparison with last season's rank and points
- **Compare Managers** - Side-by-side comparison of two managers

---

### 3. League Tab
League standings with enriched data.

#### Input:
- League ID (default: 314)

#### Features:
- **Top 50 Standings** - Rank, manager name, team, total points, GW points, rank change
- **Overall Rank** - Manager's overall ranking
- **Last Season Rank** - Previous season performance for context
- **Differential Count** - How many differentials each manager has
- **Search/Filter** - Filter by manager name
- **Sortable Columns** - Click any column header to sort
- **Rank Change Indicators** - Green arrows for rising, red for falling

---

### 4. Players Tab
Global player statistics with advanced metrics.

#### Features:
- **Player Table** - Sortable/filterable table with:
  - Player name and photo
  - Position (GKP/DEF/MID/FWD)
  - Team
  - Form (last 5 gameweeks)
  - Total Points
  - xG (Expected Goals / Threat)
  - xA (Expected Assists / Creativity)
  - ICT Index
  - DEFCON Score (defensive strength)
  - Cost
- **Position Filter** - Filter by GKP/DEF/MID/FWD
- **Sort Options** - Sort by form, total points, xG, xA, DEFCON, or ownership

---

### 5. Zones Tab
Advanced tactical analysis using 4-2-3-1 formation zones.

#### Features:
- **Per-Match Breakdowns** - For each fixture in selected GW:
  - Home/Away team pitch visualization
  - Danger zones (strongest attacking areas)
  - Vulnerability zones (weakest defensive areas)
  - DEFCON scores (defensive strength index)
  - Best attacking picks vs opponent weakness
  - Defensive picks vs weak attacks
  - Top players by form
  - Prediction (which team is favored)
- **Pitch Visualization** - Interactive SVG football pitch showing:
  - 4-2-3-1 formation zones
  - Color-coded intensity (red = attacking, blue = defensive)
  - Player names per zone with top contributor stats
- **Best Matchup Picks** - Across all next 5 GWs:
  - Attacking picks with zone match indicators
  - Defensive picks for clean sheet potential
  - Strength ratings

---

### 6. Fixtures Tab
Upcoming fixture analysis for transfer planning.

#### Features:
- **Team Fixture Grid** - All 20 teams with next 5 fixtures
  - FDR-colored cells (1=Very Easy to 5=Very Hard)
  - Home/Away indicators
  - FDR sum per team (lower = easier run)
- **Top Players Per Team** - Best 3 players by form with position, cost, and total points
- **GW Selector** - Choose starting gameweek
- **FDR Legend** - Color coding explanation

---

### 7. Captain Tab
Data-driven captain recommendations.

#### Features:
- **Captaincy xPts Model** - Projects appearance, goal, assist, clean-sheet, save, bonus, card and set-piece points, then blends the result with recent form, season PPG and the official next-GW projection.
- **Expected Minutes** - Estimates xMins from starts, appearances, average start length, availability status and chance of playing.
- **Fixture Adjustment** - Uses the correct home/away FDR, venue and every fixture in blank or double gameweeks.
- **Top 5 Captain Picks** - A focused ranking with player, fixture, form, xMins, xGI/90, ownership and xPts.
- **Best Captain** - The highest overall projection with a fixture-specific explanation.
- **Differential Captain** - The strongest secure-minutes MID/FWD below 10% ownership, relaxed to 15% only when no qualifying pick exists, with the projection gap and risk explained.

---

### 8. Ownership Tab
Track ownership shifts over time.

#### Features:
- **Top 10 Most Owned Players** - Current ownership leaders
- **Ownership Changes**:
  - Own% Last 7d
  - Own% Live (current)
  - 7-day change
  - 3-day change
  - 24-hour change
- **14-Day Trend Sparklines** - Canvas-drawn mini charts showing ownership trajectory
- **Historical Tracking** - Snapshots saved hourly to Neon PostgreSQL database
  - 30-day retention
  - 1-hour throttle between snapshots

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/bootstrap-static` | GET | All players, teams, gameweeks data |
| `/api/fixtures` | GET | All fixtures |
| `/api/analyze-manager/:id` | GET | Full manager analysis |
| `/api/compare-managers/:id1/:id2` | GET | Side-by-side manager comparison |
| `/api/price-changes` | GET | Top 15 risers and fallers |
| `/api/league-standings/:leagueId` | GET | Enriched league standings |
| `/api/zone-analysis?gw=N` | GET | Per-match zone analysis |
| `/api/fixtures-detail?gw=N` | GET | Next 5 GW fixtures for all teams |
| `/api/captain-picks?gw=N` | GET | Captain recommendations by xPts |
| `/api/ownership/history` | GET | Ownership snapshot history |
| `/api/ownership/snapshot` | POST | Save new ownership snapshot |

---

## Data Sources

- **FPL API** - Official Fantasy Premier League API (proxied through backend)
- **Neon PostgreSQL** - Ownership snapshot storage
- **Vercel** - Hosting and serverless functions

---

## Tech Stack

- **Backend:** Node.js, Express.js
- **Frontend:** Vanilla JavaScript, Tailwind CSS, Chart.js
- **Database:** Neon PostgreSQL (serverless)
- **Hosting:** Vercel
- **CDN:** Tailwind CSS, Chart.js, Font Awesome, Google Fonts

---

## Key Metrics Explained

| Metric | Description |
|--------|-------------|
| **xG** | Expected Goals - probability of scoring based on shot quality |
| **xA** | Expected Assists - probability of creating a goal |
| **xGI** | Expected Goal Involvements - xG + xA combined |
| **ICT** | Influence, Creativity, Threat index |
| **FDR** | Fixture Difficulty Rating (1-5 scale) |
| **DEFCON** | Defensive strength score (clean sheets vs goals conceded) |
| **Form** | Points scored in last 5 gameweeks |
| **PPG** | Points Per Game average |
| **xPts** | Expected Points - model prediction for upcoming GW |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NEON_DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Server port (default: 3000) |
