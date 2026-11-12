import type { Color } from '../engine/document';

export interface EraserPreferences {
    mode: 'transparent' | 'background';
    background: string;
}

// UI preferences are deliberately independent of document metadata and layer count.
export function readEraserPreferences(value: unknown): EraserPreferences {
    const prefs = value && typeof value === 'object' ? (value as Partial<EraserPreferences>) : {};
    return {
        mode: prefs.mode === 'background' ? 'background' : 'transparent',
        background:
            typeof prefs.background === 'string' && /^#[0-9a-f]{6}$/i.test(prefs.background)
                ? prefs.background.toLowerCase()
                : '#ffffff',
    };
}

export function eraserColor(prefs: EraserPreferences): Color {
    if (prefs.mode === 'transparent') return [0, 0, 0, 0];
    const channel = (at: number) => parseInt(prefs.background.slice(at, at + 2), 16);
    return [channel(1), channel(3), channel(5), 255];
}
