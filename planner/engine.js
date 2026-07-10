// docs/planner/engine.js
// Torn week-planner engine — JS port of torn_train/{formula,eventsim,planner}.py.
// Python is the source of truth; parity enforced by engine.test.mjs against
// tests/golden/engine_golden.json. Classic script (no ESM) so it works from
// file:// and via Node require().
'use strict';
const TornEngine = (() => {

  const C = {
    DAY: 1440, HAPPY_REGEN_INT: 15, HAPPY_REGEN_AMT: 5, BAR_FILL: 300,
    XAN_E: 250, XAN_H: 75, XAN_CD: 450, ECT_CD: 240, ENERGY_CAP: 1000,
    CANDY_CD: { lolli: 30, bigchoc: 30, edvd: 360 },
    CANDY_HAPPY: { lolli: 25, bigchoc: 35, edvd: 2500 },
    CANDY_CD_CAP: 1470, REFILL_E: 150, REFILL_CD: 1440, REFILL_POINTS: 30,
    HAPPY_CEIL: 99999,
    ADDICTION: { xanax: 35, ecstasy: 20 }, ADDICTION_DECAY_PER_DAY: 20,
    ITEM_IDS: { lolli: 310, bigchoc: 36, edvd: 366, xanax: 206, ecstasy: 197, mistletoe: 865 },
  };
  const regenParams = (donator) =>
    donator ? { interval: 10, amount: 5, cap: 150 } : { interval: 15, amount: 5, cap: 100 };

  // CPython round(x, n): correctly-rounded decimal, ties-to-even. Exact decimal
  // ties are unrepresentable in doubles for n>=1, so toFixed (also correctly
  // rounded) is bit-identical in practice. Never use x*10**n + Math.round.
  const pyRound = (x, digits) => Number(x.toFixed(digits));

  const FIFTY_M = 50_000_000, OVERFLOW_COEF = 0.057406, OVERFLOW_EXP = 0.928996;
  // [A, B] per stat (C_noise unused — deterministic engine only)
  const STAT_CONSTANTS = {
    strength: [1600, 1700], speed: [1600, 2000], defense: [2100, -600], dexterity: [1800, 1500],
  };

  function effectiveStatTotal(t) {
    return t <= FIFTY_M ? t : FIFTY_M + OVERFLOW_COEF * Math.pow(t - FIFTY_M, OVERFLOW_EXP);
  }

  function bracket(stat, statTotal, happy) {
    const [a, b] = STAT_CONSTANTS[stat];
    const sEff = effectiveStatTotal(statTotal);
    const logMult = pyRound(1 + 0.07 * pyRound(Math.log(1 + happy / 250), 4), 4);
    const happyCapped = Math.min(happy, C.HAPPY_CEIL);
    return sEff * logMult + 8 * Math.pow(happy, 1.05)
      + (1 - Math.pow(happyCapped / C.HAPPY_CEIL, 2)) * a + b;
  }

  function meanGain(stat, statTotal, happy, dots, energy, perkMult = 1.0) {
    return (1 / 200000) * dots * energy * perkMult * bracket(stat, statTotal, happy);
  }

  function expectedHappyLoss(energy) {
    return Math.floor(0.1 * energy * 5 + 0.5);
  }

  function simulateSession(stat, statTotal, happy, dots, energy, perkMult, budget) {
    let total = 0, curTotal = statTotal, curHappy = happy, spent = 0, trains = 0;
    if (energy <= 0) return { trains: 0, totalGain: 0, finalHappy: curHappy, energySpent: 0 };
    const loss = expectedHappyLoss(energy);
    while (spent + energy <= budget) {
      const g = meanGain(stat, curTotal, curHappy, dots, energy, perkMult);
      total += g; curTotal += g;
      curHappy = Math.max(0, curHappy - loss);
      spent += energy; trains += 1;
    }
    return { trains, totalGain: total, finalHappy: curHappy, energySpent: spent };
  }

  // snap a minute up to the next :15 boundary (or leave it if already on one)
  const snap15 = (m) => (m % 15 === 0 ? m : (Math.floor(m / 15) + 1) * 15);

  function normalizeRecipe(recipe) {
    recipe = recipe || {};
    let bigJump = null;
    if (recipe.bigJump) {
      const bj = recipe.bigJump;
      const edvdPerJump = bj.edvdPerJump || 0;
      const candyType = bj.candyType || null;
      let candyCount = bj.candyCount;
      if (candyCount === 'auto') {
        candyCount = candyType
          ? Math.max(0, Math.min(49, Math.floor(
              (C.CANDY_CD_CAP - edvdPerJump * C.CANDY_CD.edvd) / C.CANDY_CD[candyType])))
          : 0;
      } else {
        candyCount = candyCount || 0;
      }
      bigJump = {
        perWeek: bj.perWeek,
        xanaxPerJump: bj.xanaxPerJump || 0,
        edvdPerJump,
        candyType,
        candyCount,
        refill: !!bj.refill,
        consoleEnergy: bj.consoleEnergy || 0,
        consoleHappy: bj.consoleHappy || 0,
        extraHappy: bj.extraHappy || 0,
        mistletoeCount: bj.mistletoeCount || 0,
        hjServiceEdvds: bj.hjServiceEdvds || 0,
      };
    }
    let micro = null;
    if (recipe.micro) {
      const mc = recipe.micro;
      let candyCount = mc.candyCount;
      if (candyCount === 'auto') candyCount = Math.min(49, Math.floor(mc.intervalMin / 30));
      micro = { intervalMin: mc.intervalMin, candyCount };
    }
    return { bigJump, micro };
  }

  function _hhmm(minute) {
    const day = Math.floor(minute / C.DAY) + 1;
    const m = minute % C.DAY;
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return `D${day} ${hh}:${mm}`;
  }

  function simulateWeek(player, recipe, days = 7) {
    const { bigJump, micro } = normalizeRecipe(recipe);

    const { statTotal, baseHappy, dots, energyPerTrain: ePer, perkMult, donator, stat = 'defense' } = player;
    const regen = regenParams(donator);
    const totalMinutes = days * C.DAY;

    // ── Mutable state — eventsim.py:361-368 ──────────────────────────────────
    let energy = 0, happy = baseHappy, drugCd = 0, boosterCd = 0, curStat = statTotal;
    let totalGain = 0;

    // ── Accounting — eventsim.py:370-387 ──────────────────────────────────────
    let jumps = 0, microJumps = 0, xanaxUsed = 0, ecstasyUsed = 0, refills = 0, refillsMissed = 0, mistletoeUsed = 0;
    let regenWasted = 0, energyBase = 0, energyJump = 0, energyConverted = 0, energyRegenApplied = 0, xanaxWasted = 0;
    const candiesUsed = { lolli: 0, bigchoc: 0, edvd: 0 };
    const dailyCum = new Array(days).fill(0);
    const dayBaseEnergy = new Array(days).fill(0);
    const dayBaseGain = new Array(days).fill(0);
    const dayJumpGain = new Array(days).fill(0);
    const log = [];
    const warnings = [];

    const logEv = (minute, dayIdx, kind, item, detail) => {
      log.push({ minute, day: dayIdx + 1, hhmm: _hhmm(minute), kind, item, detail,
                 energyAfter: energy, happyAfter: Math.trunc(happy) });
    };

    // eventsim.py:608-631 — eat up to `count` items of `type`, stopping if the
    // booster cooldown is already at the 24.5h cap (main-mode break rule)
    const eatCandy = (type, count, minute, dayIdx) => {
      let eaten = 0;
      for (let i = 0; i < count; i++) {
        if (boosterCd >= C.CANDY_CD_CAP) break; // eventsim.py:611
        happy += C.CANDY_HAPPY[type];
        boosterCd = Math.min(C.CANDY_CD_CAP, boosterCd + C.CANDY_CD[type]); // eventsim.py:614
        eaten++;
        candiesUsed[type]++;
      }
      if (eaten > 0) {
        logEv(minute, dayIdx, 'CANDY', type,
          `${eaten}x ${type} happy+=${eaten * C.CANDY_HAPPY[type]} happy=${Math.trunc(happy)} booster_cd=${boosterCd}`);
      }
      if (eaten < count) {
        warnings.push(`Only ${eaten} of ${count} ${type} fit under the 24.5h booster cap on the D${dayIdx + 1} jump`);
      }
      return eaten;
    };

    if (!bigJump && !micro) {
      // ── Baseline: pure regen training — eventsim.py:390-441 ────────────────
      for (let minute = 0; minute < totalMinutes; minute++) {
        const dayIdx = Math.floor(minute / C.DAY);

        // eventsim.py:395-401 — baseline never exceeds cap, so no waste branch
        if (minute > 0 && minute % regen.interval === 0) {
          if (energy < regen.cap) {
            energy = Math.min(regen.cap, energy + regen.amount);
            energyRegenApplied += regen.amount;
          }
        }

        // eventsim.py:404-406 — baseline only ever regens up toward base_happy
        if (minute > 0 && minute % C.HAPPY_REGEN_INT === 0) {
          if (happy < baseHappy) happy = Math.min(baseHappy, happy + C.HAPPY_REGEN_AMT);
        }

        // eventsim.py:409-426
        if (energy >= ePer) {
          const eSpent = Math.floor(energy / ePer) * ePer;
          const sr = simulateSession(stat, curStat, happy, dots, ePer, perkMult, eSpent);
          totalGain += sr.totalGain;
          energyBase += eSpent;
          curStat += sr.totalGain;
          happy = sr.finalHappy;
          energy -= eSpent;
          dayBaseEnergy[dayIdx] += eSpent;
          dayBaseGain[dayIdx] += sr.totalGain;
        }
      }

      // eventsim.py:429-441 — baseline emits the daily summary unconditionally
      for (let d = 0; d < days; d++) {
        log.push({ minute: (d + 1) * C.DAY - 1, day: d + 1, hhmm: `D${d + 1} 23:59`, kind: 'BASE_TRAIN',
                   item: null, detail: `daily_base energy=${dayBaseEnergy[d]} gain=${dayBaseGain[d].toFixed(4)}`,
                   energyAfter: -1, happyAfter: Math.trunc(baseHappy) });
      }
    } else {
      // ── Big-jump and/or micro, one unified tick loop — task 5, no Python
      // analogue. Each intent (bigJump / micro) is guarded independently so a
      // single-block recipe walks the exact same code as before (bit-identical
      // parity); composition adds the microAllowed() gate and hold-union below.
      let nx = 0, perWeek = Infinity, spacing = 0, lastJumpMin = 0, xansTaken = 0,
          lastRefillMin = -C.REFILL_CD, jumpTarget = 0, xanSeqStart = 0;
      if (bigJump) {
        // eventsim.py:476-823, generalized via `spacing` — cycle_len / first jump
        nx = bigJump.xanaxPerJump;
        perWeek = bigJump.perWeek;
        const cycleLen = nx === 0 ? C.DAY : Math.max(C.DAY, nx * C.XAN_CD + C.ECT_CD);
        spacing = Math.max(cycleLen, snap15(Math.floor(days * C.DAY / perWeek)));
        const firstRaw = nx === 0 ? C.DAY : (nx === 1 ? C.BAR_FILL + C.XAN_CD : nx * C.XAN_CD);
        const firstTarget = snap15(firstRaw);
        lastJumpMin = firstTarget - spacing; // preseed
      }

      let effInterval = 0, microCandyCount = 0, nextMicroMin = 0;
      if (micro) {
        effInterval = Math.max(micro.intervalMin, C.ECT_CD); // eventsim.py:125
        microCandyCount = micro.candyCount;
        nextMicroMin = effInterval;
      }

      // console banks every point of regen for its own conversion; micro can
      // never coexist with it (brief's composition rule 5) — warn once, up front.
      if (bigJump && micro && bigJump.consoleEnergy > 0) {
        warnings.push('Micro jumps disabled: the console method banks every point of energy');
      }

      // brief's microAllowed(m) pseudocode: forbid a micro fire once the big
      // jump's xanax-banking/bar-fill window has begun, and require the micro's
      // own ecstasy CD + booster CD to clear before that window / the jump itself.
      const microAllowed = (m) => {
        if (!bigJump) return true;
        if (bigJump.consoleEnergy > 0) return false;
        const bankStart = nx > 0 ? xanSeqStart : jumpTarget - C.BAR_FILL;
        if (m >= bankStart) return false;
        if (m + C.ECT_CD > (nx > 0 ? bankStart : jumpTarget)) return false;
        if (m + microCandyCount * C.CANDY_CD.lolli > jumpTarget) return false;
        return true;
      };

      for (let minute = 0; minute < totalMinutes; minute++) {
        const dayIdx = Math.floor(minute / C.DAY);

        // eventsim.py:538-547 / 138-147 decrement cooldowns
        if (drugCd > 0) drugCd--;
        if (boosterCd > 0) boosterCd--;

        // eventsim.py:549-562 / 150-161 energy regen tick
        if (minute > 0 && minute % regen.interval === 0) {
          if (energy < regen.cap) {
            energy = Math.min(regen.cap, energy + regen.amount);
            energyRegenApplied += regen.amount;
          } else {
            regenWasted += regen.amount;
          }
        }

        // eventsim.py:565-569 / 164-168 quarter-hour happy clamp
        if (minute > 0 && minute % C.HAPPY_REGEN_INT === 0) {
          if (happy > baseHappy) happy = baseHappy;
          else if (happy < baseHappy) happy = Math.min(baseHappy, happy + C.HAPPY_REGEN_AMT);
        }

        const at15 = minute % 15 === 0 && minute > 0;

        if (bigJump) {
          // eventsim.py:523-532 recomputed fresh each tick from last_jump_min
          jumpTarget = snap15(lastJumpMin + spacing);
          xanSeqStart = jumpTarget - nx * C.XAN_CD;

          // eventsim.py:577-616 xanax intake
          if (nx > 0 && xansTaken < nx) {
            const nextXanDue = xanSeqStart + xansTaken * C.XAN_CD;
            if (minute >= nextXanDue && drugCd === 0) {
              // xan#1 of a fresh cycle: spend any trainable energy right now, before
              // banking starts. Xanax adds a flat amount regardless of current energy,
              // so anything left sitting here would otherwise ride into the bank and
              // (for a 4-Xan cycle, where 4*XAN_E already equals ENERGY_CAP) be wasted
              // at the cap for nothing. Skip for console methods: they deliberately
              // bank every point of energy for the console conversion instead.
              if (xansTaken === 0 && energy >= ePer && !(bigJump.consoleEnergy > 0)) {
                const eSpent = Math.floor(energy / ePer) * ePer;
                const sr = simulateSession(stat, curStat, happy, dots, ePer, perkMult, eSpent);
                totalGain += sr.totalGain;
                energyBase += eSpent;
                curStat += sr.totalGain;
                happy = sr.finalHappy;
                energy -= eSpent;
                dayBaseEnergy[dayIdx] += eSpent;
                dayBaseGain[dayIdx] += sr.totalGain;
              }
              const added = Math.min(C.XAN_E, C.ENERGY_CAP - energy);
              xanaxWasted += C.XAN_E - added;
              energy += added;
              happy = Math.min(happy + C.XAN_H, 99999);
              drugCd = C.XAN_CD;
              xansTaken++;
              xanaxUsed++;
              logEv(minute, dayIdx, 'XANAX', 'xanax',
                `xan#${xansTaken} energy+=${added} happy+=${C.XAN_H} energy=${energy} drug_cd=${drugCd}`);
            }
          }

          // eventsim.py:596-605 jump condition (+ jumps<perWeek cap)
          const allXanDone = xansTaken === nx;
          const canJump = allXanDone && drugCd === 0 && boosterCd === 0 && at15 &&
                          minute >= jumpTarget && jumps < perWeek;

          if (canJump) {
            // composition rule 4: a micro fire that ate into this big jump's
            // cooldowns can push the fire minute past its (fixed) jumpTarget.
            if (minute > jumpTarget) {
              warnings.push(`Big jump on D${Math.floor(jumpTarget / C.DAY) + 1} delayed ${minute - jumpTarget} min waiting for cooldowns`);
            }

            // eventsim.py:608-631 — eDvD "doubler" items first, then filler candy
            if (bigJump.edvdPerJump > 0) eatCandy('edvd', bigJump.edvdPerJump, minute, dayIdx);
            if (bigJump.candyType && bigJump.candyCount > 0) eatCandy(bigJump.candyType, bigJump.candyCount, minute, dayIdx);

            // eventsim.py:633-643 mistletoe happy injection (no booster CD)
            if (bigJump.extraHappy) {
              happy += bigJump.extraHappy;
              mistletoeUsed += bigJump.mistletoeCount;
              logEv(minute, dayIdx, 'MISTLETOE', 'mistletoe',
                `steal +${bigJump.extraHappy} happy -> ${Math.trunc(happy)} (HJ service)`);
            }

            // eventsim.py:645-658 Game Console conversion
            if (bigJump.consoleEnergy > 0 && energy >= bigJump.consoleEnergy) {
              energy -= bigJump.consoleEnergy;
              energyConverted += bigJump.consoleEnergy;
              happy = Math.min(happy + bigJump.consoleHappy, 99999);
              logEv(minute, dayIdx, 'CONSOLE', 'console',
                `convert ${bigJump.consoleEnergy}e -> +${bigJump.consoleHappy} happy = ${Math.trunc(happy)} (Game Console)`);
            }

            // eventsim.py:660-676 ecstasy (happy capped at the 99,999 game ceiling)
            happy = Math.min(happy * 2, 99999);
            drugCd = C.ECT_CD;
            ecstasyUsed++;
            logEv(minute, dayIdx, 'ECSTASY', 'ecstasy', `happy doubled to ${Math.trunc(happy)}`);

            // eventsim.py:678-704 dump the banked energy
            const dumpEnergy = energy;
            if (dumpEnergy >= ePer) {
              const sr = simulateSession(stat, curStat, happy, dots, ePer, perkMult, dumpEnergy);
              totalGain += sr.totalGain;
              energyJump += dumpEnergy;
              curStat += sr.totalGain;
              happy = sr.finalHappy;
              energy -= dumpEnergy; // eventsim.py:689 — full-zeroing (dumpEnergy === energy)
              dayJumpGain[dayIdx] += sr.totalGain;
              logEv(minute, dayIdx, 'JUMP', 'jump',
                `energy_dumped=${dumpEnergy} trains=${sr.trains} gain=${sr.totalGain.toFixed(4)} final_happy=${Math.trunc(happy)}`);
            }

            // eventsim.py:706-735 points refill + re-dump (energy=150 overwrite)
            if (bigJump.refill) {
              if (minute - lastRefillMin >= C.REFILL_CD) {
                energy = regen.cap; // eventsim.py:711 overwrite, not additive; refill fills to YOUR cap
                refills++;
                lastRefillMin = minute;
                logEv(minute, dayIdx, 'REFILL', 'refill', `energy refilled to ${regen.cap} (30 points)`);
                if (energy >= ePer) {
                  const sr2 = simulateSession(stat, curStat, happy, dots, ePer, perkMult, energy);
                  totalGain += sr2.totalGain;
                  energyJump += energy;
                  curStat += sr2.totalGain;
                  dayJumpGain[dayIdx] += sr2.totalGain;
                  logEv(minute, dayIdx, 'JUMP', 'jump',
                    `refill dump energy=${energy} trains=${sr2.trains} gain=${sr2.totalGain.toFixed(4)} final_happy=${Math.trunc(sr2.finalHappy)}`);
                  happy = sr2.finalHappy;
                  energy = 0;
                }
              } else {
                refillsMissed++;
              }
            }

            // eventsim.py:737-740
            jumps++;
            lastJumpMin = minute;
            xansTaken = 0;
            continue; // skip base train / micro this minute
          }
        }

        if (micro) {
          // eventsim.py:170-172 fire condition, gated by microAllowed for composition
          const canMicroJump = microAllowed(minute) && drugCd === 0 && at15 && minute >= nextMicroMin;

          if (canMicroJump) {
            // eventsim.py:174-188 — eat lollipops; micro's break rule differs from
            // main mode: bail if this candy would push the booster past the cap.
            let eaten = 0;
            for (let i = 0; i < microCandyCount; i++) {
              if (boosterCd + C.CANDY_CD.lolli > C.CANDY_CD_CAP) break; // eventsim.py:183
              happy += C.CANDY_HAPPY.lolli;
              boosterCd = Math.min(C.CANDY_CD_CAP, boosterCd + C.CANDY_CD.lolli);
              eaten++;
              candiesUsed.lolli++;
            }
            if (eaten > 0) {
              logEv(minute, dayIdx, 'CANDY', 'lolli',
                `${eaten}x lolli happy+=${eaten * C.CANDY_HAPPY.lolli} happy=${Math.trunc(happy)} booster_cd=${boosterCd}`);
            }

            // eventsim.py:205-208 ecstasy — NO 99,999 clamp in micro mode (mirrors the quirk)
            happy *= 2;
            drugCd = C.ECT_CD;
            ecstasyUsed++;
            logEv(minute, dayIdx, 'ECSTASY', 'ecstasy', `happy doubled to ${Math.trunc(happy)}`);

            // eventsim.py:220-246 dump the banked energy (session-then-zero)
            const dumpEnergy = energy;
            if (dumpEnergy >= ePer) {
              const sr = simulateSession(stat, curStat, happy, dots, ePer, perkMult, dumpEnergy);
              totalGain += sr.totalGain;
              energyJump += dumpEnergy;
              curStat += sr.totalGain;
              happy = sr.finalHappy;
              energy -= dumpEnergy;
              dayJumpGain[dayIdx] += sr.totalGain;
              logEv(minute, dayIdx, 'JUMP', 'jump',
                `energy_dumped=${dumpEnergy} trains=${sr.trains} gain=${sr.totalGain.toFixed(4)} final_happy=${Math.trunc(happy)}`);
            }

            // eventsim.py:248-255
            microJumps++;
            nextMicroMin = snap15(minute + effInterval);
            continue; // skip base train this minute
          }
        }

        // base-train hold = union of the big-jump hold and the micro hold
        let bigHold = false;
        if (bigJump) {
          // eventsim.py:746-761 base-train hold rules. No "xan seq start arrived" hold:
          // Xanax adds a flat amount regardless of current energy, so there's nothing to
          // preserve ahead of xan#1 — that energy is trained inline in the xanax-intake
          // block instead (right before xan#1 fires), so it isn't wasted at the cap.
          const inBanking = xansTaken > 0;
          const barFilling = nx === 0 && minute >= jumpTarget - C.BAR_FILL;
          const bankForConsole = bigJump.consoleEnergy > 0;
          bigHold = inBanking || barFilling || bankForConsole;
        }
        let microHold = false;
        if (micro) {
          // eventsim.py:257-269 base-train hold rule
          if (effInterval <= C.BAR_FILL) {
            microHold = true; // short interval: never base-train, let energy pile up
          } else {
            microHold = (nextMicroMin - minute) <= C.BAR_FILL;
          }
        }

        if (!bigHold && !microHold && energy >= ePer) {
          const eSpent = Math.floor(energy / ePer) * ePer;
          const sr = simulateSession(stat, curStat, happy, dots, ePer, perkMult, eSpent);
          totalGain += sr.totalGain;
          energyBase += eSpent;
          curStat += sr.totalGain;
          happy = sr.finalHappy;
          energy -= eSpent;
          dayBaseEnergy[dayIdx] += eSpent;
          dayBaseGain[dayIdx] += sr.totalGain;
        }
      }

      // eventsim.py:776-789 / 290-304 — jump modes only emit the daily row if energy was spent
      for (let d = 0; d < days; d++) {
        if (dayBaseEnergy[d] > 0) {
          log.push({ minute: (d + 1) * C.DAY - 1, day: d + 1, hhmm: `D${d + 1} 23:59`, kind: 'BASE_TRAIN',
                     item: null, detail: `daily_base energy=${dayBaseEnergy[d]} gain=${dayBaseGain[d].toFixed(4)}`,
                     energyAfter: -1, happyAfter: -1 });
        }
      }

      // brief step 8: end-of-run warning if fewer big jumps fit than requested
      if (bigJump && jumps < perWeek) {
        warnings.push(`You asked for ${perWeek} big jumps this week — only ${jumps} fit (cooldown cadence).`);
      }
      // composition rule 3: count micro windows lost to big-jump suppression
      // (the console case already warned above with a more specific message)
      if (bigJump && micro && !(bigJump.consoleEnergy > 0)) {
        const microTheoretical = Math.floor(totalMinutes / effInterval);
        if (microJumps < microTheoretical) {
          warnings.push(`${microTheoretical - microJumps} micro jump(s) lost to big-jump banking/cooldowns`);
        }
      }
    }

    // eventsim.py:789-796 / 306-313 — stable sort by minute only. A kind-priority
    // tiebreak can't represent REFILL, which sits *between* the two same-minute
    // JUMP entries it produces; insertion order already matches true execution
    // order within a minute, so plain stable sort on minute preserves it.
    log.sort((a, b) => a.minute - b.minute);

    // eventsim.py:803-807 / 443-447 — cumulative daily gain
    let cum = 0;
    for (let d = 0; d < days; d++) {
      cum += dayBaseGain[d] + dayJumpGain[d];
      dailyCum[d] = cum;
    }

    return {
      totalGain, jumps, microJumps, xanaxUsed, candiesUsed, ecstasyUsed, refills, refillsMissed,
      mistletoeUsed, regenWasted, xanaxWasted, energyBase, energyJump, energyConverted, energyRegenApplied,
      finalEnergy: energy, dailyCum, log, warnings,
    };
  }

  const ITEM_NAMES = {
    lolli: 'Lollipop', bigchoc: 'Big Box of Chocolates', edvd: 'Erotic DVD',
    xanax: 'Xanax', ecstasy: 'Ecstasy', point: 'Points (refills)', mistletoe: 'Poison Mistletoe',
  };

  function summarize(player, recipe, prices, days = 7) {
    const result = simulateWeek(player, recipe, days);
    const baseline = simulateWeek(player, {}, days);
    const { bigJump } = normalizeRecipe(recipe);
    const hjServiceEdvds = bigJump ? bigJump.hjServiceEdvds : 0;
    const serviceFee = hjServiceEdvds * result.jumps * prices.edvd;

    const cost = result.candiesUsed.lolli * prices.lolli
      + result.candiesUsed.bigchoc * prices.bigchoc
      + result.candiesUsed.edvd * prices.edvd
      + result.xanaxUsed * prices.xanax
      + result.ecstasyUsed * prices.ecstasy
      + result.refills * C.REFILL_POINTS * prices.point
      + result.mistletoeUsed * prices.mistletoe
      + serviceFee;

    const addictionGross = result.xanaxUsed * C.ADDICTION.xanax + result.ecstasyUsed * C.ADDICTION.ecstasy;
    const addictionNet = Math.max(0, addictionGross - C.ADDICTION_DECAY_PER_DAY * days);
    const dosesPerWeek = result.xanaxUsed + result.ecstasyUsed;

    const extraGain = result.totalGain - baseline.totalGain;
    const costPerExtraStat = (cost > 0 && extraGain > 0) ? cost / extraGain : null;

    const shopping = [];
    const addLine = (item, count, unit) => {
      if (count > 0) shopping.push({ item, count, unit, total: count * unit });
    };
    addLine(ITEM_NAMES.lolli, result.candiesUsed.lolli, prices.lolli);
    addLine(ITEM_NAMES.bigchoc, result.candiesUsed.bigchoc, prices.bigchoc);
    addLine(ITEM_NAMES.edvd, result.candiesUsed.edvd, prices.edvd);
    addLine(ITEM_NAMES.xanax, result.xanaxUsed, prices.xanax);
    addLine(ITEM_NAMES.ecstasy, result.ecstasyUsed, prices.ecstasy);
    addLine(ITEM_NAMES.point, result.refills * C.REFILL_POINTS, prices.point);
    addLine(ITEM_NAMES.mistletoe, result.mistletoeUsed, prices.mistletoe);
    addLine('eDvD (HJ service fee)', hjServiceEdvds * result.jumps, prices.edvd);

    const warnings = [...result.warnings];
    if (addictionNet > 0) {
      warnings.push(`Net +${addictionNet} addiction/week — this compounds; plan rehab or expect stat debuffs`);
    }
    if (dosesPerWeek > 0) {
      warnings.push(`${dosesPerWeek} Xanax+Ecstasy doses/week — 150 lifetime doses locks you out of the drug-free Sports Science Lab gym`);
    }

    return {
      result, baseline, extraGain, cost, costPerExtraStat, addictionNet, addictionGross,
      dosesPerWeek, shopping, warnings,
    };
  }

  return {
    C, regenParams, pyRound, effectiveStatTotal, meanGain, expectedHappyLoss, simulateSession,
    normalizeRecipe, simulateWeek, summarize,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TornEngine;
if (typeof globalThis !== 'undefined') globalThis.TornEngine = TornEngine;
