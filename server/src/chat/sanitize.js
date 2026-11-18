export const MAX_CHAT_LENGTH = 1000;

// Server-side clean-up of chat text (spec 10.1: prevent stored XSS).
// Chat is plain text: HTML tags are removed, invisible control characters are
// dropped and whitespace is tidied. The React client also renders messages as
// text (never as HTML), so this is a second layer of defence.
export function sanitizeChat(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFC')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '') // tags like <script>, </b>, <img src=x>
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
