import {getString} from './settingsAccess.js';
// The name the assistant goes by in the interface, chosen in Preferences.
// The extension itself, and the tools and instructions that refer to the
// product, keep the name GNOME Assistant.
export const DEFAULT_ASSISTANT_NAME = 'GNOME Assistant';
export const MAX_ASSISTANT_NAME_LENGTH = 40;

export function normalizeAssistantName(value) {
    const name = [...String(value ?? '').replace(/\s+/g, ' ').trim()].slice(0, MAX_ASSISTANT_NAME_LENGTH).join('').trim();
    return name || DEFAULT_ASSISTANT_NAME;
}

export function assistantName(settings) {
    try {
        return normalizeAssistantName(getString(settings, 'assistant-name'));
    } catch {
        return DEFAULT_ASSISTANT_NAME;
    }
}

// Told to the agent only when the user picked another name.
export function assistantNameInstructions(name) {
    return name === DEFAULT_ASSISTANT_NAME ? ''
        : `In this interface the user calls you "${name}". Use that name if you refer to yourself.`;
}
