export type Surface = HTMLCanvasElement | OffscreenCanvas;
export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export function createSurface(width: number, height: number): Surface {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}
export function context2D(surface: Surface): Context2D {
    const context = surface.getContext('2d') as Context2D | null;
    if (!context) throw Error('2D 화면을 만들 수 없습니다. 다른 브라우저에서 다시 시도하세요.');
    return context;
}
