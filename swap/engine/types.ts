// The swap engine is a fixed pipeline with four pluggable parts. Each part is an interface below; implementations
// live in ./providers and are picked by name in ./registry (env SWAP_*), so a new model or vendor is one new file.
//
//   guard ─▶ image editor (target frames) ─▶ user picks ─▶ video editor (one run per version) ─▶ checker ─▶ finish
//
// The method (target frame first, one change per run, source sound put back, automatic QA) follows Scenario's
// ALTER skill, vendored under swap/vendor/alter (MIT).

export type Ratio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9';

/** Screens the user's upload before anything is paid for. */
export interface Guard {
  name: string;
  inspect(image: string): Promise<GuardResult>;
}
export type GuardResult = { ok: boolean; face: 'none' | 'real' | 'stylised' | 'unknown'; message?: string };

/** Makes target frames: one frame of the source with the change already done, photographed in its light. */
export interface ImageEditor {
  name: string;
  /** Returns local file paths of the candidates. `refs[0]` is the source frame, the rest are the user's images. */
  targetFrames(x: { prompt: string; refs: string[]; ratio: Ratio; count: number; outDir: string; log: Log; bill?: Bill }): Promise<string[]>;
}

/** Edits the source video with the target frame as @image1. Must keep the source's motion, camera and timing. */
export interface VideoEditor {
  name: string;
  /** Shortest and longest source this editor accepts, in seconds. Longer sources are cut into segments. */
  minSeconds: number;
  maxSeconds: number;
  /** Most reference pictures one run accepts; default 5. */
  maxRefs?: number;
  /** How this vendor names references in a prompt; prompts are written with @image1 / @video1. */
  bindRefs?(prompt: string): string;
  /** `audio`: a soundtrack reference (@audio1) and the prompt sentence that binds it. An editor may drop it
   *  (e.g. on a moderation refusal) and must then drop the sentence too; it returns what it actually used. */
  edit(x: { prompt: string; source: string; images: string[]; audio?: AudioRef; ratio: Ratio; duration: number; outFile: string; log: Log; bill?: Bill }): Promise<string>;
}

export type AudioRef = { file: string; line: string; dropped?: boolean };

/** Compares an output with its source. Never blocks delivery on its own: it reports, the pipeline decides. */
export interface Checker {
  name: string;
  check(source: string, output: string, mode: CheckMode, outDir: string): Promise<CheckReport>;
}
export type CheckMode = 'swap' | 'recast' | 'motion' | 'restyle';
export type CheckReport = { pass: boolean; summary: string; trimTail: number; sheet?: string; raw?: any };

export type Log = (msg: string) => void;

/** One paid call, as the vendor billed it. `yuan` undefined = not known (yet); the page says so. */
export type CostItem = { step: string; model: string; units: string; yuan?: number; taskId?: string; note?: string; at: number };
/** Providers call this once per paid call; the pipeline fills in `step` and `at`. */
export type Bill = (c: Omit<CostItem, 'step' | 'at'>) => void;

// ---------- templates ----------

/** A slot is the one thing the user replaces. `preset` names an entry in ./presets. */
export type Slot = {
  id: string; label: string; hint: string;
  preset: string;
  /** Words for the preset's {placeholders}, e.g. { object: 'white paper coffee cup' }. */
  fill: Record<string, string>;
  /** Instruction for the image editor that builds the target frame. */
  framePrompt: string;
  /** Ways the user can apply their picture, e.g. 换整个人 / 只换脸. The first is the default; each overrides
   *  the slot's preset, fill and framePrompt, and the template's whoAfter. */
  modes?: SlotMode[];
};
export type SlotMode = { id: string; label: string; hint?: string; preset?: string; fill: Record<string, string>; framePrompt: string; whoAfter?: string };

/** A version is an extra change, run on the previous result (a chain), one change per run.
 *  With `framePrompt` the server builds its own target frame (no user upload, no pick); without it the preset
 *  must work from the prompt alone (restyles, time of day, weather, era...). */
export type Version = { id: string; label: string; preset: string; fill: Record<string, string>; framePrompt?: string;
  /** Who the preset's opening keeps, when it is not the main character (e.g. the crowd). */
  who?: string };

/** A pick-one group of chained changes, e.g. 人群服装: 红裙 / 婚纱. Runs after the slot, before the versions. */
export type Choice = { id: string; label: string; options: Version[] };

export type Template = {
  id: string; title: string; desc: string;
  /** Files relative to the template folder. */
  source: string; cover?: string;
  ratio: Ratio; seconds: number;
  /** The person, described without the thing that changes ("the young man with short blond hair"). */
  who: string;
  /** The same person after the slot's swap, for versions chained on the swapped result ("the character in front"). */
  whoAfter?: string;
  /** Where to take the target frame from, in seconds. */
  frameAt: number;
  slot: Slot;
  choices?: Choice[];
  versions: Version[];
  /** Soundtrack handed to the video model as @audio1, so movements follow the beat and mouths are not invented:
   *  'source' = the template's own sound; a file name = a similar substitute track in the template folder (for
   *  music that trips moderation); absent = no audio reference. The delivered video always gets the source sound. */
  audio?: string;
  /** Hard cuts (real shot changes) in seconds, for clips longer than the model's limit; detected when absent. */
  cuts?: number[];
  /** Shown as a small tag, e.g. 内部测试 for clips we do not own. */
  note?: string;
};

// ---------- jobs ----------

export type TextEditKind = 'background' | 'object';
export type TextEdit = { kind: TextEditKind; text: string; source: string };

export type Stage ='checking' | 'framing' | 'pick' | 'slots' | 'rendering' | 'done' | 'failed';
export type VersionRun = {
  id: string; label: string;
  status: 'waiting' | 'running' | 'done' | 'failed';
  /** What it is doing now, e.g. 第 2/3 段. */
  step?: string;
  output?: string; final?: string; compare?: string;
  preset?: string; who?: string; segments?: SegTrace[]; startedAt?: number; endedAt?: number;
  check?: CheckReport; error?: string;
};
/** One picture handed to a model, and why. */
export type RefTrace = { role: string; file: string };
/** What one segment of one version sent and got back: the record the 链路复盘 page shows. */
export type SegTrace = {
  index: number; start: number; end: number; join: 'start' | 'hard' | 'soft';
  source?: string;
  /** Server-built target frame for this segment, if any. */
  autoFrame?: { prompt: string; refs: RefTrace[]; out: string };
  images: RefTrace[];
  audio?: RefTrace & { dropped?: boolean };
  /** For a segment after the first: previous result's last frame | this result's first frame. */
  seam?: string;
  prompt?: string; sentPrompt?: string; model?: string;
  edit?: string; ms?: number;
  qa?: { pass: boolean; summary: string; sheet?: string; crops?: string; metrics?: Record<string, number> };
};
export type Job = {
  /** The server process that last wrote this job. */
  pid?: number;
  id: string; templateId: string; created: number;
  stage: Stage; message: string;
  upload: string; guard?: GuardResult;
  frames: string[]; picked?: number;
  /** Which implementation ran each part. */
  engine?: { image: string; video: string; guard: string; checker: string };
  /** How the previews were made: the template frame, the user's picture, the instruction. */
  framing?: { prompt: string; refs: RefTrace[]; frameAt: number; model: string; attempts: number };
  versions: VersionRun[];
  /** Every paid call this job made, in order. */
  costs?: CostItem[];
  /** Slot mode the user chose (Slot.modes), if the template has modes. */
  slotMode?: string;
  /** Option ids the user picked in choices, then version ids they ticked. */
  extras: string[];
  /** Set for a 文字改视频 job (templateId 'text'): the user's own video, changed from words alone. */
  textEdit?: TextEdit;
  log: string[];
  error?: string;
  /** Set for a 一键复刻 job (./director.ts): review → plan → assets → keyframes → segments → repair → compose. */
  replica?: Replica;
};

// ---------- 一键复刻 ----------

export type PhaseId = 'review' | 'plan' | 'assets' | 'keyframes' | 'generate' | 'repair' | 'compose' | 'voice';
export type Phase = { id: PhaseId; label: string; status: 'waiting' | 'running' | 'done' | 'skipped' | 'failed'; note?: string };

/** What the review decided: what stays, what changes, the fewest keyframes that pin it all down. */
export type Plan = {
  /** The source's captions and titles come out of the picture: our own subtitles replace them. */
  dropText?: boolean;
  /** English, for model prompts. */
  subject: string; target: string; keep: string; change: string;
  /** Chinese, for the user. */
  summary: string;
  /** Views the film needs that the user's pictures lack (e.g. side, back, folded); empty = no asset completion. */
  views: string[];
  /** The same views for the user: where the film shows each one, so the page can ask for a picture. */
  gaps?: Gap[];
  /** Colour / style versions of the target in the film. `main` = shown as uploaded; the others get a recoloured asset. */
  variants: Variant[];
  scenes: { id: string; shots: number[]; keyAt: number; edit: string; variant?: string }[];
  shots: { index: number; start: number; end: number; change: boolean; scene: string; note: string }[];
  /** 'llm' or 'basic' (no model: every shot changes, one scene). */
  by: string;
};
/** A picture found online. It only ever shows shape: colour and markings stay with the user's own pictures. */
export type WebPic = { file: string; url: string; page?: string; why?: string; label?: string };
/** One round of the scout, for 链路复盘. */
export type ScoutStep = { round: number; seconds: number; searches: string[]; said: string;
  pics: { id: string; file?: string; url: string; page?: string; error?: string }[]; picks: { gap: string; id: string; why: string; refused?: string }[]; finish?: string };
/** Something the film shows that the user's pictures do not.
 *  angle: another view of the same thing (default; old jobs have no kind). part: another part of it, like a car's cabin.
 *  screen: a real on-screen operation; never searched for or generated, only the user can supply it. */
export type Gap = { view: string; label: string; at: number; frame?: string; kind?: 'angle' | 'part' | 'screen';
  /** Chinese: what to supply and how to shoot it. */ need?: string; /** Chinese: what happens without it. */ fallback?: string;
  /** Found by the scout, waiting for the user's yes on 开始前确认. */ found?: WebPic };
export type Variant = { id: string; label: string; desc: string; main: boolean; at: number; /** That version in the film, shown on its slot. */ frame?: string };
export type VariantAsset = { id: string; label: string; file?: string; ok?: boolean; issue?: string; /** The user's own picture for this slot. */ own?: boolean };
/** One line of captions / voiceover that no longer fits the new product. `sure` = readable from the picture;
 *  otherwise a fact the picture cannot give (brand, material) that the user should check. */
/** One spoken line: what the source says and what the new voice says. */
export type VoiceLine = { start: number; end: number; from: string; to: string };
export type Voice = { status: 'running' | 'done' | 'failed'; lines?: VoiceLine[]; by?: string; error?: string };
/** src: where the line was found — the spoken voiceover, the on-screen captions, or both. */
export type CopyItem = { at: number; from: string; to: string; sure: boolean; why?: string; src?: 'voice' | 'caption' | 'both' };
export type Keyframe = { scene: string; at: number; source: string; out?: string; prompt?: string; tries: number; ok?: boolean; issue?: string };
/** One generated piece. `genStart` < `start` when it carries an overlap with the previous piece (soft seam). */
export type ReplicaSeg = {
  index: number; start: number; end: number; genStart: number; join: 'start' | 'hard' | 'soft';
  scenes: string[]; prompt?: string; images: string[]; source?: string; fit?: string;
  tries: number; status: 'waiting' | 'running' | 'done' | 'failed';
  /** lookBad: the look check found a real fault; only that and a bad seam cause a redo. motion: ALTER's score, to compare takes. */
  qa?: { pass: boolean; summary: string; seam?: number; look?: string; lookBad?: boolean; motion?: number };
  repaired?: boolean; error?: string;
};
export type Replica = {
  source: string; prompt: string; uploads: string[];
  /** Photos of the same model found elsewhere (other colourways allowed): shape from other angles only. */
  shapeRefs?: string[];
  /** 商品库 entry this job reads from and writes its real photos back to (engine/products.ts). */
  productId?: string;
  /** The product's known pitfalls when the job started; kept here so a resumed job checks the same things. */
  productNotes?: string[];
  /** The product's name, for the scout: a picture alone rarely tells the exact model. */
  productName?: string;
  /** Pictures found online by earlier jobs of this product; the scout may reuse them. Not real photos: never in `uploads`. */
  knownWeb?: WebPic[];
  /** What the scout did, for 链路复盘. */
  /** Which real photos each scene uses, best first (engine/picks.ts). Absent: upload order. */
  photoPicks?: import('./picks').PhotoPicks;
  /** Why the last 重做这段 did not work; the film is unchanged. */
  redoError?: string;
  /** Every keyframe failed its check, so nothing was generated; the user may go on anyway. */
  keyframeStop?: boolean;
  /** 简单路线 or 完整路线, and why (engine/route.ts). */
  route?: import('./route').Route;
  /** The uncut source, when 只复刻能做的部分 cut shots out of `source`. */
  fullSource?: string;
  /** The user's switch on the upload page: look online for missing parts, in the background. */
  scoutOn?: boolean;
  scout?: { running?: boolean; rounds: number; viewed: number; found: number; stopped: string; steps?: ScoutStep[] };
  /** false = keep the source sound and captions: no change list, no new voice. */
  voiceOn?: boolean;
  /** Style versions to make once the film is done (director STYLES keys). */
  styles?: string[];
  phases: Phase[];
  plan?: Plan;
  /** Completed multi-view sheet of the user's asset, when the film needs views the uploads lack. */
  sheet?: { file?: string; views: string[]; ok?: boolean; issue?: string };
  /** The user's thing in each colour the film shows, made from their picture. */
  variantAssets?: VariantAsset[];
  /** Captions and voiceover to rewrite for the new product. */
  copy?: CopyItem[];
  /** What the copy check looked at: spoken lines heard in the source (0 = none, or music only), and whether it finished. */
  copyCheck?: { heard: number; done: boolean; error?: string };
  voice?: Voice;
  /** The final video before sound and subtitles, so they can be redone without touching the picture. */
  picture?: string;
  keyframes: Keyframe[];
  segments: ReplicaSeg[];
};
