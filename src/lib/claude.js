import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Check https://docs.claude.com/en/docs/about-claude/models for current IDs.
const MODEL = 'claude-sonnet-5';

export async function ask(prompt, { system, maxTokens = 1500, images = [] } = {}) {
  const content = images.length
    ? [
        ...images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        })),
        { type: 'text', text: prompt },
      ]
    : prompt;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content }],
  });

  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Same as ask(), but returns a JSON object instead of text. Forces the reply through a
 * tool call rather than asking the model to type out JSON as prose — free-text JSON
 * occasionally comes back with a stray character (e.g. a semicolon slipped in before a
 * comma) that breaks JSON.parse even though the model "meant" valid JSON. Tool-call
 * arguments are decoded by the API itself, not string-parsed by us, so that failure mode
 * doesn't apply here.
 *
 * Pass `schema` (a JSON Schema object with `properties`) whenever you know the exact
 * shape wanted — an unconstrained `{type: "object"}` schema gives the model no signal
 * about field boundaries, and under that ambiguity it can bleed formatting from a
 * different tool-call convention into a text field (e.g. a long "reasoning" string
 * trailing off into stray `</reasoning><parameter name="risks">` text) instead of
 * cleanly starting the next property. An explicit schema fixes that at the source.
 */
export async function askJSON(prompt, { system, maxTokens = 1500, images = [], schema } = {}) {
  const content = images.length
    ? [
        ...images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        })),
        { type: 'text', text: prompt },
      ]
    : prompt;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content }],
    tools: [
      {
        name: 'respond',
        description:
          "Submit your answer. The prompt describes a JSON object with specific top-level keys — " +
          'call this tool with exactly those keys as the top-level arguments. Do not nest them under ' +
          'a wrapper key (no {"response": {...}} or similar) — the tool input itself must be that object.',
        input_schema: schema ?? { type: 'object' },
      },
    ],
    tool_choice: { type: 'tool', name: 'respond' },
  });

  const toolUse = res.content.find((b) => b.type === 'tool_use');
  if (!toolUse) {
    throw new Error(
      `Model did not return a tool call (stop_reason: ${res.stop_reason}). ` +
        'If stop_reason is max_tokens, the reply was cut off — raise maxTokens.'
    );
  }

  // Despite the instruction above, the model occasionally wraps the answer under a single
  // key instead of putting the requested fields at the top level. Every prompt in this
  // codebase asks for several top-level keys, so a lone key whose value is itself an object
  // is always that wrapping, never a legitimate answer — unwrap it.
  const keys = Object.keys(toolUse.input);
  if (keys.length === 1 && toolUse.input[keys[0]] !== null && typeof toolUse.input[keys[0]] === 'object' && !Array.isArray(toolUse.input[keys[0]])) {
    return toolUse.input[keys[0]];
  }
  return toolUse.input;
}
