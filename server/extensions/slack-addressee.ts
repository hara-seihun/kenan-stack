/** Whether a Slack message's own words address Kenan, beyond a real <@U000EXAMPLE0> mention.
 * October 29: Morgan's Slack app sent "@Kenan new ask ..." as plain text, so the socket path added no eyes and the
 * acknowledgement came 3 minutes 50 seconds later by hand. "Kenan, could you ..." is addressed too; a third-person
 * or possessive mention ("Kenan's PR merged", "Kenan fixed it") is not a request. Same rule and shared fixtures as
 * deploy/slack-addressee.py; the Acme sender's slackMessageInvokesKenan applies it as well. */
const KENAN = 'U000EXAMPLE0';
const GREETING = String.raw`(?:(?:hey|hi|hello|yo|to|dear|ok|okay|thanks|morning|good morning)[\s,!]+)?`;
const REQUEST_OPENER = String.raw`(?:please|pls|plz|(?:can|could|would|will|wanna|do|did|are|have|should)\s+(?:you|we|u)|`
  + String.raw`what|why|how|when|where|which|who|is\s+(?:it|there|this|that)|any|let(?:'s|\s+(?:me|us))|`
  + String.raw`check|look|take|send|post|draft|give|help|find|run|pull|grab|write|add|update|fix|estimate|`
  + String.raw`ship|merge|review|make|build|deploy|share|summari[sz]e|compare|investigate|tell|show|get|`
  + String.raw`new\s+ask|quick\s+(?:one|question|ask))\b`;
const LEADING = new RegExp(String.raw`^${GREETING}(?:@kenan(?=[\s,:;!?.]|$)|kenan\s*[,:;]|kenan\s+${REQUEST_OPENER})`, 'i');
const TOKEN = /(?<![\w@.])@kenan(?![\w'’-])/i;

export function slackProse(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, '')
    .replace(/(^|\n)\s*>>>[\s\S]*$/g, '')
    .replace(/^\s*(?:>|&gt;).*$/gm, '')
    .replace(/“[^”]*”|‘[^’]*’|"[^"\n]*"|(?:^|\s)'[^'\n]*'/g, '')
    .replace(/<https?:\/\/[^>]*>|https?:\/\/\S+/g, '');
}

export function namesKenan(text: string): boolean {
  if (text.includes(`<@${KENAN}>`) || new RegExp(`<@${KENAN}\\|[^>]*>`).test(text)) return true;
  const words = slackProse(text);
  return LEADING.test(words.trim()) || TOKEN.test(words);
}
