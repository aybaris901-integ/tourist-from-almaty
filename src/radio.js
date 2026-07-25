import { randRange } from './utils.js';

export const CONFIG = {
  CALL_INTERVAL_MIN: 25,
  CALL_INTERVAL_MAX: 40,
  POST_DODGE_DELAY: 4, // a dodge pulls the next call in to ~this many seconds
  ANSWER_WINDOW: 5, // seconds the player has to press 1/2/3
  COOLDOWN: 20, // can't fire more than once per this many seconds
  FEAR_ANSWER_DELTA: -20,
  HIGH_FEAR_THRESHOLD: 70, // above this, calls come 20% more often — a lifeline when it's needed
  HIGH_FEAR_INTERVAL_MULT: 0.8,
};

// Placeholder lines; real voice/writing is a later pass.
const LINES = [
  {
    prompt: 'Unknown caller: "Do you have ANY idea how much airspace you are violating right now?"',
    options: ['[funny reply A]', '[funny reply B]', '[funny reply C]'],
  },
  {
    prompt: 'Unknown caller: "Sir. Sir. This is NOT a drill, sir."',
    options: ['[funny reply A]', '[funny reply B]', '[funny reply C]'],
  },
  {
    prompt: 'Unknown caller: "We have missile lock. Please respond."',
    options: ['[funny reply A]', '[funny reply B]', '[funny reply C]'],
  },
  {
    prompt: 'Unknown caller: "That was a stolen F-22 you just barrel-rolled, correct?"',
    options: ['[funny reply A]', '[funny reply B]', '[funny reply C]'],
  },
];

// Radio calls are a scarce, player-managed resource: answering costs
// attention (you keep flying while reading) but pays off in fear relief.
// The game never pauses for this — see radio.active usage in main.js/ui.js.
export class Radio {
  constructor(audio) {
    this.audio = audio;
    this.active = false;
    this.subtitle = '';
    this.options = [];
    this.answerTimer = 0;

    this._cooldownTimer = 0;
    this._nextCallTimer = randRange(CONFIG.CALL_INTERVAL_MIN, CONFIG.CALL_INTERVAL_MAX);
    this._fear = null;
    this._forcedLine = null;

    this._bindKeys();
  }

  // route.js uses this for the Kazakhstan wave's scripted intro call —
  // overrides the next call's line and pulls its timing in.
  queueIntro(line, delay) {
    this._forcedLine = line;
    this._nextCallTimer = Math.min(this._nextCallTimer, delay);
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.code === 'Digit1') this._answer(0);
      if (e.code === 'Digit2') this._answer(1);
      if (e.code === 'Digit3') this._answer(2);
    });
  }

  // A clean dodge hurries up the next call (never delays it beyond whatever
  // was already scheduled).
  notifyDodge() {
    this._nextCallTimer = Math.min(this._nextCallTimer, CONFIG.POST_DODGE_DELAY);
  }

  update(dt, fear) {
    this._fear = fear;
    if (this._cooldownTimer > 0) this._cooldownTimer -= dt;

    if (this.active) {
      this.answerTimer -= dt;
      if (this.answerTimer <= 0) {
        console.log('[radio] call missed (no answer)');
        this._endCall();
      }
      return;
    }

    this._nextCallTimer -= dt;
    if (this._nextCallTimer <= 0) {
      if (this._cooldownTimer > 0) {
        // Scarce resource: still on cooldown, retry right as it clears.
        this._nextCallTimer = this._cooldownTimer;
        return;
      }
      this._startCall();
    }
  }

  _startCall() {
    const line = this._forcedLine || LINES[Math.floor(Math.random() * LINES.length)];
    this._forcedLine = null;
    this.subtitle = line.prompt;
    this.options = line.options;
    this.active = true;
    this.answerTimer = CONFIG.ANSWER_WINDOW;
    this.audio.playRadioBlip();
    console.log('[radio] incoming call');
  }

  _answer(index) {
    const chosen = this.options[index];
    console.log(`[radio] answered: "${chosen}"`);
    this._fear.addInstant('radio-answer', CONFIG.FEAR_ANSWER_DELTA);
    this._endCall();
  }

  _endCall() {
    this.active = false;
    this.subtitle = '';
    this.options = [];
    this._cooldownTimer = CONFIG.COOLDOWN;
    this._nextCallTimer = this._rollNextCallInterval();
  }

  // Above HIGH_FEAR_THRESHOLD, calls come 20% more often — the world throws
  // the player a lifeline right when fear is closing in on the 100 panic
  // threshold, instead of leaving them to sweat out a long random gap.
  _rollNextCallInterval() {
    const interval = randRange(CONFIG.CALL_INTERVAL_MIN, CONFIG.CALL_INTERVAL_MAX);
    const highFear = this._fear && this._fear.value > CONFIG.HIGH_FEAR_THRESHOLD;
    return highFear ? interval * CONFIG.HIGH_FEAR_INTERVAL_MULT : interval;
  }
}