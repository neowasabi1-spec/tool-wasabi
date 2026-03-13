/**
 * Gemini Computer Use — REST API client.
 *
 * The Computer Use model analyzes browser screenshots and returns
 * UI actions (click_at, type_text_at, scroll, etc.) with normalized coordinates
 * on a 0-999 grid that are then denormalized to real screen dimensions.
 *
 * Model: gemini-2.5-computer-use-preview-10-2025
 * Ref: https://ai.google.dev/gemini-api/docs/computer-use
 */

// =====================================================
// CONSTANTS
// =====================================================

export const COMPUTER_USE_MODEL = 'gemini-2.5-computer-use-preview-10-2025';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GRID_SIZE = 1000; // Normalized coordinates 0-999

/** Recommended dimensions from Google documentation */
export const RECOMMENDED_SCREEN_WIDTH = 1440;
export const RECOMMENDED_SCREEN_HEIGHT = 900;

// =====================================================
// TYPES
// =====================================================

export interface CUContentPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    parts?: { inlineData: { mimeType: string; data: string } }[];
  };
}

export interface CUContent {
  role: 'user' | 'model';
  parts: CUContentPart[];
}

export interface CUSafetyDecision {
  explanation: string;
  decision: 'require_confirmation' | 'allowed' | string;
}

export interface CUAction {
  name: string;
  args: Record<string, unknown>;
  safetyDecision?: CUSafetyDecision;
}

export interface CUModelResponse {
  /** Model reasoning/thinking text */
  text?: string;
  /** UI actions suggested by the model */
  actions: CUAction[];
  /** Full model content (to add to history) */
  modelContent: CUContent;
  /** Flag: the model has finished (no actions, text only) */
  isTaskComplete: boolean;
}

// =====================================================
// COORDINATE DENORMALIZATION
// =====================================================

/** Converts normalized X coordinate (0-999) to real pixels */
export function denormalizeX(x: number, screenWidth: number): number {
  return Math.round((x / GRID_SIZE) * screenWidth);
}

/** Converts normalized Y coordinate (0-999) to real pixels */
export function denormalizeY(y: number, screenHeight: number): number {
  return Math.round((y / GRID_SIZE) * screenHeight);
}

// =====================================================
// API CALL
// =====================================================

/**
 * Calls the Gemini Computer Use model with the full conversation history.
 * Returns suggested actions and model content to add to history.
 */
export async function callComputerUse(
  apiKey: string,
  contents: CUContent[],
  excludedActions?: string[],
): Promise<CUModelResponse> {
  const url = `${API_BASE}/models/${COMPUTER_USE_MODEL}:generateContent?key=${apiKey}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const computerUseConfig: Record<string, any> = {
    environment: 'ENVIRONMENT_BROWSER',
  };
  if (excludedActions?.length) {
    computerUseConfig.excluded_predefined_functions = excludedActions;
  }

  const body = {
    contents,
    tools: [
      {
        computerUse: computerUseConfig,
      },
    ],
    generationConfig: {
      temperature: 0.2,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini Computer Use API ${response.status}: ${errText.slice(0, 500)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as any;
  const candidate = data.candidates?.[0];

  if (!candidate?.content?.parts) {
    throw new Error('Gemini Computer Use: no candidate in response');
  }

  const modelContent: CUContent = {
    role: 'model',
    parts: candidate.content.parts,
  };

  // Parse response parts
  let text = '';
  const actions: CUAction[] = [];

  for (const part of candidate.content.parts) {
    if (part.text) {
      text += part.text + '\n';
    }
    if (part.functionCall) {
      const { name, args } = part.functionCall;

      // Extract safety_decision from args (if present)
      let safetyDecision: CUSafetyDecision | undefined;
      const cleanArgs = { ...args };
      if (cleanArgs.safety_decision) {
        safetyDecision = cleanArgs.safety_decision as CUSafetyDecision;
        delete cleanArgs.safety_decision;
      }

      actions.push({ name, args: cleanArgs, safetyDecision });
    }
  }

  const isTaskComplete = actions.length === 0 && text.trim().length > 0;

  return {
    text: text.trim() || undefined,
    actions,
    modelContent,
    isTaskComplete,
  };
}

// =====================================================
// FUNCTION RESPONSE BUILDERS
// =====================================================

/**
 * Creates a functionResponse ContentPart with attached screenshot.
 * Format required by Computer Use for post-execution feedback.
 */
export function buildFunctionResponsePart(
  actionName: string,
  currentUrl: string,
  screenshotBase64: string,
  screenshotMimeType: string = 'image/jpeg',
  extraFields?: Record<string, unknown>,
): CUContentPart {
  return {
    functionResponse: {
      name: actionName,
      response: { url: currentUrl, ...extraFields },
      parts: [
        {
          inlineData: {
            mimeType: screenshotMimeType,
            data: screenshotBase64,
          },
        },
      ],
    },
  };
}

/**
 * Creates the "user" Content with all function responses for a turn.
 * Each executed action generates a functionResponse with the post-action screenshot.
 */
export function buildFunctionResponseContent(
  results: { actionName: string; error?: string; safetyAcknowledged?: boolean }[],
  currentUrl: string,
  screenshotBase64: string,
  screenshotMimeType: string = 'image/jpeg',
): CUContent {
  const parts: CUContentPart[] = results.map((r) => {
    const extra: Record<string, unknown> = {};
    if (r.error) extra.error = r.error;
    if (r.safetyAcknowledged) extra.safety_acknowledgement = 'true';
    return buildFunctionResponsePart(
      r.actionName,
      currentUrl,
      screenshotBase64,
      screenshotMimeType,
      extra,
    );
  });

  return { role: 'user', parts };
}

// =====================================================
// CONVERSATION WINDOW MANAGEMENT
// =====================================================

/**
 * Sliding window management of conversation history.
 * Removes screenshots from older function responses
 * to avoid exceeding token/payload limits.
 *
 * Only keeps screenshots from the last `keepScreenshots` turns.
 */
export function trimConversationHistory(
  contents: CUContent[],
  keepScreenshots: number = 15,
): void {
  // Count how many user turns with functionResponse exist
  let frTurnCount = 0;
  const frTurnIndices: number[] = [];

  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content.role === 'user') {
      const hasFR = content.parts.some((p) => p.functionResponse);
      if (hasFR) {
        frTurnCount++;
        frTurnIndices.push(i);
      }
    }
  }

  // If we have more turns with screenshots than the limit, remove old ones
  if (frTurnCount > keepScreenshots) {
    const toStrip = frTurnIndices.slice(keepScreenshots); // indices of old turns
    for (const idx of toStrip) {
      const content = contents[idx];
      for (const part of content.parts) {
        if (part.functionResponse?.parts) {
          // Remove inline_data (screenshot) but keep the rest
          part.functionResponse.parts = [];
        }
      }
    }
  }
}

// =====================================================
// INITIAL CONTENT BUILDER
// =====================================================

/**
 * Creates the initial content for the agent loop:
 * system prompt + initial page screenshot.
 */
export function buildInitialContent(
  prompt: string,
  screenshotBase64: string,
  screenshotMimeType: string = 'image/jpeg',
): CUContent {
  return {
    role: 'user',
    parts: [
      { text: prompt },
      {
        inlineData: {
          mimeType: screenshotMimeType,
          data: screenshotBase64,
        },
      },
    ],
  };
}
