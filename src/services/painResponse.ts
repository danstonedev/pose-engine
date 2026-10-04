/** Authored expression of movement-evoked pain, not a pain measurement or reflex model.
 * Channel weights/timing are animation choices. See docs/pain-responses.md.
 */
export interface PainResponseInput {
  intensity: number; // selected 0–10; never inferred from ROM or appearance
  expression?: number; // 0–1; a quiet patient can still have severe pain
  pattern?: PainResponsePatternId;
  onsetMs: number;
  releaseMs: number;
  timeMs: number; // playback time: pause, seek and loop remain deterministic
}
export interface PainResponse {
  activation: number;
  brow: number;
  browRaise: number;
  squint: number;
  eyeClosure: number;
  nose: number;
  mouth: number;
  jawOpen: number;
  mouthOpen: number;
  handClench: number;
  flinch: number;
  guarding: number;
  shift: number;
}
export const PAIN_RESPONSE_PATTERNS = [
  {id:'grimace',label:'Sustained grimace',description:'Furrowed brow, narrowed eyes and mouth tension with sustained free-hand tightening.',recoil:1},
  {id:'wince',label:'Brief wince',description:'A brief eyelid squeeze and hand pulse at onset, followed by much less visible tension.',recoil:1},
  {id:'eye-squeeze',label:'Eyes shut & squeeze',description:'More eye closure and sustained free-hand squeezing, with less brow movement.',recoil:0.35},
  {id:'open-mouth',label:'Open-mouth response',description:'Narrowed eyes and an opening mouth, with a brief free-hand squeeze.',recoil:0.55},
  {id:'raised-brow',label:'Raised-brow tension',description:'Raised inner brows, some eyelid tension and a smaller sustained hand response.',recoil:0.25},
  {id:'quiet',label:'Quiet response',description:'No added facial reaction or recoil; a small free-hand tightening can still be visible.',recoil:0},
] as const;
export type PainResponsePatternId = (typeof PAIN_RESPONSE_PATTERNS)[number]['id'];
export function painResponsePattern(id: unknown) {
  return PAIN_RESPONSE_PATTERNS.find(pattern=>pattern.id===id) ?? PAIN_RESPONSE_PATTERNS[0];
}
const unit = (n: number) => Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
const smooth = (n: number) => { const x = unit(n); return x * x * (3 - 2 * x); };
/** Scale an existing authored recoil; does not add a new trajectory or infer a reflex. */
export function painRecoilScale(input: Pick<PainResponseInput,'intensity'|'expression'|'pattern'>): number {
  return unit(input.intensity/10)*unit(input.expression??0.65)*painResponsePattern(input.pattern).recoil;
}
export function painResponseAt(input: PainResponseInput): PainResponse {
  const { timeMs, onsetMs, releaseMs } = input;
  const valid = [timeMs, onsetMs, releaseMs].every(Number.isFinite) && releaseMs > onsetMs;
  const elapsed = valid ? timeMs - onsetMs : -1;
  const activation = valid ? smooth(elapsed / 320) * (1 - smooth((timeMs - releaseMs) / 700)) : 0;
  const level = unit(input.intensity / 10), expression = unit(input.expression ?? 0.65);
  const strength = level * expression;
  const late = smooth((level - 0.3) / 0.7);
  // One onset recoil, followed by a sustained response. No repeated startle at each draw.
  const pulse = elapsed > 0 && elapsed < 600 ? Math.sin(Math.PI * elapsed / 600) ** 2 : 0;
  const a = activation * strength;
  const response: PainResponse = {
    activation,
    brow: a * 0.75, browRaise:0, squint: a * 0.65,
    eyeClosure: a * late * (0.45 + 0.4 * pulse),
    nose: a * late * 0.5, mouth: a * (0.25 + 0.45 * late), jawOpen:0, mouthOpen:0,
    handClench: a * late, flinch: pulse * strength * late * activation,
    guarding: a * late,
    // Bounded non-periodic settling shift; hosts enable only with reviewed support.
    shift: a * late * smooth((elapsed - 600) / 600),
  };
  switch(painResponsePattern(input.pattern).id) {
    case 'wince': {
      const brief=0.12+0.88*pulse;
      response.brow=a*0.65*brief; response.squint=a*0.8*brief;
      response.eyeClosure=a*late*0.85*brief; response.nose=a*late*0.35*brief;
      response.mouth=a*0.45*brief; response.handClench=a*late*(0.08+0.72*pulse);
      break;
    }
    case 'eye-squeeze':
      response.brow=a*0.25; response.squint=a*0.7; response.eyeClosure=a*late*0.85;
      response.nose=a*late*0.15; response.mouth=a*0.4; response.handClench=a*late;
      break;
    case 'open-mouth':
      response.brow=a*0.45; response.squint=a*0.6; response.eyeClosure=a*late*0.15;
      response.nose=a*late*0.15; response.mouth=0; response.jawOpen=a*(0.25+0.35*late);
      response.mouthOpen=a*0.55;
      response.handClench=a*late*(0.1+0.75*pulse);
      break;
    case 'raised-brow':
      response.brow=0; response.browRaise=a*0.7; response.squint=a*0.3; response.eyeClosure=a*late*0.1;
      response.nose=0; response.mouth=a*0.2; response.handClench=a*late*0.35;
      break;
    case 'quiet':
      response.brow=response.squint=response.eyeClosure=response.nose=response.mouth=0;
      response.handClench=a*late*0.2;
      break;
  }
  response.flinch*=painResponsePattern(input.pattern).recoil;
  return response;
}
export const PAIN_FACE_CHANNELS = {
  Brow_Drop_L: 'brow', Brow_Drop_R: 'brow',
  Brow_Raise_Inner_L: 'browRaise', Brow_Raise_Inner_R: 'browRaise',
  Eye_Squint_L: 'squint', Eye_Squint_R: 'squint',
  Eye_Blink_L: 'eyeClosure', Eye_Blink_R: 'eyeClosure',
  Nose_Sneer_L: 'nose', Nose_Sneer_R: 'nose',
  Mouth_Press_L: 'mouth', Mouth_Press_R: 'mouth',
  Jaw_Open:'jawOpen',
  V_Lip_Open:'mouthOpen',
} as const;
