/** Tool catalogue + fixed spoken answers. Same for LiveVoice and ClassicVoice. */

export const TOOL_NAMES = [
  'where_am_i', 'start_narration', 'stop_narration', 'find_object', 'stop_finding',
  'read_text', 'describe_now', 'ask_about_view', 'take_me_to', 'switch_camera',
  'repeat_last', 'more_detail', 'less_detail', 'help',
] as const;

export const HELP_TEXT =
  'You can say: where am I, find something, describe around me, read text, narrate, take me somewhere, switch camera, repeat, more detail, or less detail.';

export const TAKE_ME_TO_SOON =
  'Navigation is coming soon. I can tell you what is around you now.';

export const READY_TEXT =
  'Eye assistant is ready. You can say: where am I, find something, describe around me, read text, or take me somewhere.';

export const GREETING =
  "Hi, I'm your eye assistant. Which camera should I use, back or front?";

export function cameraAnnounce(which: 'back' | 'front'): string {
  return `Using the ${which} camera.`;
}

export function parseCameraChoice(text: string): 'back' | 'front' | null {
  const t = text.toLowerCase();
  if (/\b(front|selfie|forward)\b/.test(t)) return 'front';
  if (/\b(back|rear|backward)\b/.test(t)) return 'back';
  return null;
}
