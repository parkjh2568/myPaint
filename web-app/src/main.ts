import { isDesktop, activateNative, openNative, saveNative } from './platform/native';
import './style.css';
import { createSurface, context2D } from './platform/surface';
import { FinalSceneCache, type PixelRect, type SceneRaster } from './platform/tiles';
import {
    PaintDocument,
    validate,
    webLimits,
    desktopLimits,
    createState,
    cloneState,
    composite,
    validateSize,
    type State,
    type Color,
} from './engine/document';
import { applySelectionMask, resizeState, resizeNearestSteps, snapLineDelta } from './engine/operations';
import { runCodec, runGeometry, readArtwork, exportBytes, type Raster } from './platform/codec';
import { RecoveryStore, type RecoveryEntry } from './platform/storage';
import { icon, toolDefinitions, type Tool } from './ui/icons';
import { readEraserPreferences, eraserColor } from './ui/eraser';
interface Point {
    x: number;
    y: number;
    pressure: number;
}
interface Selection extends Raster {
    x: number;
    y: number;
    source?: { x: number; y: number; width: number; height: number };
    modified: boolean;
    sourceMask?: Uint8Array;
    originalPixels?: Uint8ClampedArray;
    resizeSource?: Raster;
}
interface TextLayout {
    width: number;
    height: number;
    font: string;
    fontSize: number;
    lines: { text: string; y: number }[];
    foreground: string;
    background?: string;
}
interface Drag {
    pointer: number;
    mode: string;
    start: Point;
    last: Point;
    offsetX: number;
    offsetY: number;
    selectionX?: number;
    selectionY?: number;
    selectionModified?: boolean;
    selectionRaster?: Raster;
    selectionResizeSource?: Raster;
    resizeReleased?: boolean;
    previousShapeSecondary?: boolean;
    canvasEdge?: string;
    canvasWidth?: number;
    canvasHeight?: number;
    canvasOwner?: State;
    canvasRevision?: number;
    canvasEpoch?: number;
}
interface Field {
    key: string;
    label: string;
    type?: string;
    value?: string;
    options?: string[];
    min?: number;
    max?: number;
}
const runtimeProfile = window.__TAURI__?.core ? desktopLimits : webLimits;
const minZoom = Math.min(1 / 64, 32 / runtimeProfile.dimension);
class Studio {
    doc = new PaintDocument(createState(800, 600, [0, 0, 0, 0], runtimeProfile), runtimeProfile);
    tool: Tool = 'brush';
    eraserPreferences = readEraserPreferences(null);
    foreground: Color = [22, 121, 234, 255];
    secondary: Color = [255, 255, 255, 255];
    size = 12;
    opacity = 100;
    hardness = 100;
    stabilization = 25;
    pressure = true;
    square = false;
    fillShape = false;
    outlineShape = true;
    shapeSecondary = false;
    transparentSelection = false;
    fingerDraw = true;
    root: HTMLElement;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    workspace: HTMLElement;
    canvasBounds: HTMLDivElement;
    brushCursor: HTMLDivElement;
    status: HTMLElement;
    layerList: HTMLElement;
    title: HTMLElement;
    zoom = 1;
    offsetX = 0;
    offsetY = 0;
    autoFit = true;
    viewWidth = 0;
    viewHeight = 0;
    viewLeft = 0;
    viewTop = 0;
    frame = 0;
    fullPixels = true;
    pendingDirty = new Map<Uint8ClampedArray, PixelRect[]>();
    name = '제목 없음';
    busy = false;
    epoch = 1;
    nativeReady: Promise<void> = Promise.resolve();
    nativeInitialized = !isDesktop();
    abort?: AbortController;
    selectionPreparation?: { abort?: () => void };
    selectionResize?: { drag: Drag; width: number; height: number; cancel?: () => void };
    mouseButtonMask = 0;
    downloadUrl?: string;
    private currentSelection?: Selection;
    get selection(): Selection | undefined {
        return this.currentSelection;
    }
    set selection(value: Selection | undefined) {
        if (value !== this.currentSelection) this.selectionCache = undefined;
        this.currentSelection = value;
    }
    private currentEditor?: HTMLTextAreaElement;
    get editor(): HTMLTextAreaElement | undefined {
        return this.currentEditor;
    }
    set editor(value: HTMLTextAreaElement | undefined) {
        if (value !== this.currentEditor) this.composing = false;
        if (!value) this.textPoint = undefined;
        this.currentEditor = value;
    }
    textPoint?: Point;
    composing = false;
    fontSize = 24;
    fontFamily = 'sans-serif';
    fontBold = false;
    fontItalic = false;
    textBackground = false;
    drag?: Drag;
    pointers = new Map<number, { x: number; y: number; type: string }>();
    navigation?: { distance: number; zoom: number; anchorX: number; anchorY: number };
    points: Point[] = [];
    curveControls: Point[] = [];
    sprayTimer?: ReturnType<typeof setInterval>;
    sceneCache = new FinalSceneCache();
    renderPending = false;
    renderContextLost = false;
    renderPainting = false;
    renderPreparation?: {
        key: unknown[];
        source: FinalSceneCache['source'];
        rasters: SceneRaster[];
        index: number;
        matrix: DOMMatrix;
        viewport: PixelRect;
        channel?: MessageChannel;
        queued: boolean;
        announced: boolean;
    };
    recovery = new RecoveryStore(runtimeProfile);
    recoveredRevision = 0;
    recoveryBusy = false;
    recoveryOpening = false;
    hue = 0.58;
    colorDrag = 0;
    wheel?: HTMLCanvasElement;
    skin = 'studio';
    density = 'auto';
    densityPending = false;
    selectionCache?: {
        selection: Selection;
        pixels: Uint8ClampedArray;
        revision: number;
        cutOwner: object;
    };
    constructor() {
        this.root = document.getElementById('app')!;
        this.root.innerHTML = `<header class="topbar"><strong class="brand">myPaint</strong><button data-command="menu" aria-label="파일 및 편집 메뉴">${icon('menu')}</button><button data-command="open" aria-label="파일 열기">${icon('open')}<span class="button-text">열기</span></button><button data-command="undo" aria-label="실행 취소">${icon('undo')}</button><button data-command="redo" aria-label="다시 실행">${icon('redo')}</button><span class="title"></span><button class="mobile-only" data-command="properties" aria-label="색상과 브러시">${icon('palette')}</button><button class="mobile-only" data-command="layers" aria-label="레이어 패널">${icon('layers')}</button><button data-command="settings" class="settings-button" aria-label="테마 · 환경설정">${icon('settings')}<span>설정</span></button><button data-command="export" aria-label="이미지 내보내기">${icon('export')}<span class="button-text">내보내기</span></button><button data-command="save" class="primary" aria-label="프로젝트 저장 또는 다운로드">${icon('save')}<span class="button-text">프로젝트</span></button></header><main class="body"><nav class="tools" aria-label="그리기 도구"></nav><section class="workspace"><canvas tabindex="0" aria-label="그리기 캔버스. B 브러시, E 지우개, V 선택, H 화면 이동"></canvas><button class="resize-cancel" hidden aria-label="선택 크기 변경 취소">${icon('close')}<span>크기 변경 취소</span></button></section><aside class="inspector" aria-label="색상, 브러시, 레이어"><h2>색상 · 브러시 <button class="mobile-only close-panel" data-command="close-panel" aria-label="패널 닫기">${icon('close')}</button></h2><div class="properties"><fieldset class="eraser-options"><legend>지우개 설정</legend><label for="eraser-mode">지우는 방식</label><select id="eraser-mode"><option value="transparent">투명하게 지우기</option><option value="background">배경색으로 지우기</option></select><label for="eraser-color">지우개 배경색 <input id="eraser-color" type="color" value="#ffffff"></label><small>활성 레이어에만 적용 · 기존 그림과 문서 바탕은 유지</small></fieldset><div class="color-preview" role="img" aria-label="현재 전경색"></div><div class="color-row"><input id="color" type="color" aria-label="전경색"><input id="hex" type="text" maxlength="7" aria-label="HEX 색상" spellcheck="false"></div><label>보조색 <input id="secondary" type="color" aria-label="보조색"><button data-command="swap" aria-label="전경색 보조색 바꾸기">↔</button></label><div class="presets"><button data-preset="ink">잉크</button><button data-preset="soft">부드러운 붓</button><button data-preset="pixel">픽셀</button></div><div class="control"><label for="size">크기 <output id="size-value">12 px</output></label><input id="size" type="range" min="1" max="100" value="12"></div><div class="control"><label for="opacity">불투명도 <output id="opacity-value">100%</output></label><input id="opacity" type="range" min="1" max="100" value="100"></div><div class="control"><label for="hardness">경도 <output id="hardness-value">100%</output></label><input id="hardness" type="range" min="0" max="100" value="100"></div><div class="control"><label for="stabilization">선 보정 <output id="stabilization-value">25</output></label><input id="stabilization" type="range" min="0" max="75" value="25"></div><label><input id="pressure" type="checkbox" checked>펜 필압으로 크기 조절</label><label><input id="finger" type="checkbox" checked>손가락으로 그리기</label><label><input id="square" type="checkbox">사각 브러시</label><p class="square-hint" hidden>사각 도구는 픽셀 경계가 선명한 선을 그립니다. 불투명도·경도·선 보정·필압 설정은 둥근 도구에 적용됩니다.</p><label><input id="fill-shape" type="checkbox">도형 내부 채우기</label><label><input id="outline-shape" type="checkbox" checked>도형 윤곽선</label><label><input id="transparent-selection" type="checkbox">선택의 보조색을 투명하게</label><div class="swatches" aria-label="색상 모음"></div><button data-command="text-options">글꼴 · 문자 설정</button></div><section class="layers"><h2>레이어 · 위 → 아래</h2><div class="layer-list"></div><div class="layer-actions"><button data-command="layer-add" aria-label="레이어 추가">${icon('plus')}</button><button data-command="layer-delete" aria-label="레이어 삭제">${icon('minus')}</button><button data-command="layer-up" aria-label="레이어 위로 이동">↑</button><button data-command="layer-down" aria-label="레이어 아래로 이동">↓</button><button data-command="layer-merge" aria-label="아래 레이어와 병합">⇣</button><button data-command="layer-rename" aria-label="레이어 이름 변경">✎</button></div></section></aside></main><footer class="statusbar"><span class="tool-name">브러시</span><span class="document-info"></span><span class="status" role="status" aria-live="polite">기기 안에서 편집 · 파일을 업로드하지 않습니다</span><div class="zoom-controls"><button data-command="zoom-out" aria-label="축소">${icon('minus')}</button><span id="zoom">100%</span><button data-command="zoom-in" aria-label="확대">${icon('plus')}</button><button data-command="fit" aria-label="화면에 맞추기">${icon('fit')}</button></div></footer>`;
        this.workspace = this.root.querySelector('.workspace')!;
        this.canvas = this.workspace.querySelector('canvas')!;
        this.canvasBounds = document.createElement('div');
        this.canvasBounds.className = 'canvas-bounds';
        for (const [edge, label] of [
            ['e', '캔버스 너비 조절'],
            ['s', '캔버스 높이 조절'],
            ['se', '캔버스 너비와 높이 조절'],
        ]) {
            const handle = document.createElement('button');
            handle.type = 'button';
            handle.className = 'canvas-handle canvas-handle-' + edge;
            handle.dataset.canvasResize = edge;
            handle.setAttribute('aria-label', label);
            handle.title = label + ' · 드래그 또는 방향키 · Enter로 정확한 크기 입력';
            handle.onpointerdown = (e) => {
                e.stopPropagation();
                void this.run(() => this.pointerDown(e), true);
            };
            handle.onclick = (e) => {
                if (!e.detail) void this.run(() => this.command('canvas-size'));
            };
            handle.onkeydown = (e) => {
                if (!e.key.startsWith('Arrow')) return;
                e.preventDefault();
                e.stopPropagation();
                const step = e.shiftKey ? 10 : 1,
                    width =
                        this.doc.state.width +
                        (edge.includes('e')
                            ? e.key === 'ArrowRight'
                                ? step
                                : e.key === 'ArrowLeft'
                                  ? -step
                                  : 0
                            : 0),
                    height =
                        this.doc.state.height +
                        (edge.includes('s')
                            ? e.key === 'ArrowDown'
                                ? step
                                : e.key === 'ArrowUp'
                                  ? -step
                                  : 0
                            : 0);
                if (width === this.doc.state.width && height === this.doc.state.height) return;
                void this.run(async () => {
                    if (this.busy || this.drag || this.doc.stroke) throw Error('현재 조작을 마치세요.');
                    validateSize(width, height, this.doc.state.layers.length, runtimeProfile);
                    await this.editDocument(
                        '캔버스 크기 변경',
                        { kind: 'resize', width, height, scale: false },
                        false,
                    );
                    this.autoFit = false;
                });
            };
            this.canvasBounds.append(handle);
        }
        const size = document.createElement('output');
        size.className = 'canvas-resize-size';
        this.canvasBounds.append(size);
        this.brushCursor = document.createElement('div');
        this.brushCursor.className = 'brush-cursor';
        this.brushCursor.hidden = true;
        this.workspace.append(this.canvasBounds, this.brushCursor);
        this.ctx = this.canvas.getContext('2d')!;
        this.status = this.root.querySelector('.status')!;
        this.layerList = this.root.querySelector('.layer-list')!;
        this.title = this.root.querySelector('.title')!;
        this.root.querySelector<HTMLButtonElement>('.resize-cancel')!.onclick = () =>
            this.run(() => {
                if (!this.selectionResize) return;
                this.cancelPointer();
                this.message('크기 변경을 취소했습니다.');
                this.canvas.focus();
            });
        const tools = this.root.querySelector('.tools')!;
        for (const [id, label, key] of toolDefinitions) {
            const b = document.createElement('button');
            b.dataset.tool = id;
            b.dataset.secondary = String(!['brush', 'eraser', 'select', 'pan'].includes(id));
            b.innerHTML = icon(id);
            b.title = label + (key ? ` (${key})` : '');
            b.setAttribute('aria-label', label);
            tools.append(b);
        }
        const more = document.createElement('button');
        more.className = 'more-tools';
        more.dataset.command = 'tools';
        more.innerHTML = icon('menu');
        more.setAttribute('aria-label', '모든 도구');
        tools.append(more);
        this.createColorWheel();
        const swatches = [
            '#000000',
            '#ffffff',
            '#687386',
            '#b6c1ce',
            '#1679ea',
            '#8058e8',
            '#f08063',
            '#e3b66a',
            '#35b69a',
            '#c64f71',
            '#be2d33',
            '#167448',
            '#173479',
            '#894b19',
            '#e9dbe8',
            '#f9e7b0',
        ];
        for (const color of swatches) {
            const b = document.createElement('button');
            b.style.setProperty('--swatch', color);
            b.setAttribute('aria-label', `전경색 ${color}`);
            b.onclick = () => {
                this.foreground = this.color(color);
                this.sync();
            };
            this.root.querySelector('.swatches')!.append(b);
        }
        this.root.addEventListener('click', (e) => {
            const b = (e.target as Element).closest<HTMLButtonElement>('button');
            if (!b) return;
            this.run(async () => {
                if (b.dataset.tool) this.chooseTool(b.dataset.tool as Tool);
                else if (b.dataset.command) await this.command(b.dataset.command);
                else if (b.dataset.preset) {
                    this.chooseTool(b.dataset.preset === 'pixel' ? 'pencil' : 'brush');
                    this.hardness = b.dataset.preset === 'soft' ? 25 : 100;
                    this.opacity = 100;
                    this.stabilization = b.dataset.preset === 'pixel' ? 0 : 25;
                    this.sync();
                }
            });
        });
        for (const id of ['eraser-mode', 'eraser-color'])
            this.root.querySelector<HTMLInputElement | HTMLSelectElement>('#' + id)!.onchange = (e) => {
                if (this.busy || this.drag || this.doc.stroke) {
                    this.sync(false);
                    return;
                }
                const value = (e.target as HTMLInputElement).value;
                this.eraserPreferences = readEraserPreferences({
                    ...this.eraserPreferences,
                    [id === 'eraser-mode' ? 'mode' : 'background']: value,
                });
                this.applyPreferences();
                this.sync(false);
            };
        for (const id of ['size', 'opacity', 'hardness', 'stabilization'])
            this.root.querySelector<HTMLInputElement>('#' + id)!.oninput = (e) => {
                const value = Number((e.target as HTMLInputElement).value);
                if (id === 'size') this.size = value;
                else if (id === 'opacity') this.opacity = value;
                else if (id === 'hardness') this.hardness = value;
                else this.stabilization = value;
                this.sync(false);
            };
        for (const id of [
            'pressure',
            'finger',
            'square',
            'fill-shape',
            'outline-shape',
            'transparent-selection',
        ])
            this.root.querySelector<HTMLInputElement>('#' + id)!.onchange = (e) => {
                const on = (e.target as HTMLInputElement).checked;
                if (id === 'pressure') this.pressure = on;
                else if (id === 'finger') this.fingerDraw = on;
                else if (id === 'square') {
                    this.square = on;
                    this.sync(false);
                } else if (id === 'fill-shape') this.fillShape = on;
                else if (id === 'outline-shape') this.outlineShape = on;
                else this.transparentSelection = on;
            };
        for (const id of ['color', 'hex', 'secondary'])
            this.root.querySelector<HTMLInputElement>('#' + id)!.onchange = (e) => {
                const input = e.target as HTMLInputElement;
                if (!/^#[0-9a-f]{6}$/i.test(input.value)) {
                    this.message('HEX 색상은 #1679ea처럼 입력하세요.');
                    this.sync();
                    return;
                }
                if (id === 'secondary') this.secondary = this.color(input.value);
                else this.foreground = this.color(input.value);
                this.sync();
            };
        this.canvas.onpointerdown = (e) => this.run(() => this.pointerDown(e), true);
        this.canvas.onpointermove = (e) => {
            const show =
                !this.busy &&
                this.drag?.mode !== 'canvas-resize' &&
                !this.renderPending &&
                !document.querySelector('dialog[open]') &&
                e.pointerType !== 'touch' &&
                ['brush', 'pencil', 'eraser', 'color-eraser', 'spray'].includes(this.tool);
            this.brushCursor.hidden = !show;
            if (show) {
                const diameter =
                    (this.tool === 'pencil' ? 1 : this.tool === 'spray' ? this.size * 2 : this.size) *
                    this.zoom;
                this.brushCursor.style.width = this.brushCursor.style.height = Math.max(1, diameter) + 'px';
                this.brushCursor.style.left = e.clientX - this.viewLeft + 'px';
                this.brushCursor.style.top = e.clientY - this.viewTop + 'px';
                this.brushCursor.style.borderRadius = this.square || this.tool === 'pencil' ? '0' : '50%';
            }
            try {
                this.pointerMove(e);
            } catch (error) {
                this.run(() => {
                    throw error;
                }, true);
            }
        };
        this.canvas.onpointerleave = () => {
            this.brushCursor.hidden = true;
        };
        this.canvas.onpointerup = (e) => this.run(() => this.pointerUp(e), true);
        this.canvas.onpointercancel = (e) => this.cancelPointer(e.pointerId);
        this.canvas.onlostpointercapture = (e) => {
            if (this.pointers.has(e.pointerId)) this.cancelPointer(e.pointerId);
        };
        this.canvas.oncontextmenu = (e) => e.preventDefault();
        this.canvas.ondblclick = (e) => {
            if (!this.busy && this.tool === 'polygon' && !this.drag) {
                e.preventDefault();
                this.run(() => this.commitPolygon());
            }
        };
        this.canvas.onwheel = (e) => {
            e.preventDefault();
            if (
                this.busy ||
                this.pointers.size ||
                this.doc.stroke ||
                this.navigation ||
                (this.drag && !this.drag.resizeReleased) ||
                document.querySelector('dialog[open]')
            )
                return;
            const rect = this.canvas.getBoundingClientRect();
            if (e.ctrlKey || e.metaKey)
                this.changeZoom(
                    this.zoom * (e.deltaY > 0 ? 0.9 : 1.1),
                    e.clientX - rect.left,
                    e.clientY - rect.top,
                );
            else {
                this.autoFit = false;
                this.offsetX -= e.deltaX;
                this.offsetY -= e.deltaY;
                this.draw();
            }
        };
        this.canvas.addEventListener('contextlost', () => {
            this.renderContextLost = true;
            this.cancelRenderPreparation();
            this.sceneCache.clear();
            this.renderPending = true;
            this.canvas.dataset.ready = 'false';
            this.message('화면 연결이 중단됐습니다. 프로젝트를 저장하고 다시 여세요.');
        });
        this.canvas.addEventListener('contextrestored', () => {
            this.renderContextLost = false;
            this.cancelRenderPreparation();
            this.sceneCache.clear();
            this.draw(true);
        });
        document.addEventListener('keydown', (e) => this.keyboard(e));
        document.addEventListener('paste', (event) => {
            const target = event.target;
            if (
                target instanceof Element &&
                target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
            )
                return;
            if (
                !this.nativeInitialized ||
                this.busy ||
                this.drag ||
                this.composing ||
                this.selectionResize ||
                document.querySelector('dialog[open]')
            )
                return;
            const items = Array.from(event.clipboardData?.items || []),
                preferred =
                    items.find((item) => item.kind === 'file' && item.type === 'image/png') ||
                    items.find((item) => item.kind === 'file' && item.type.startsWith('image/')),
                file =
                    preferred?.getAsFile() ||
                    Array.from(event.clipboardData?.files || []).find((file) =>
                        file.type.startsWith('image/'),
                    );
            if (!file) return;
            event.preventDefault();
            void this.run(() => this.paste(file));
        });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.cancelPointer();
        });
        window.addEventListener('blur', () => this.cancelPointer());
        window.addEventListener('beforeunload', (e) => {
            if (this.doc.dirty || this.hasPending()) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
        document.addEventListener('dragover', (e) => {
            if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
        });
        document.addEventListener('drop', (e) => {
            if (e.dataTransfer?.files.length) {
                e.preventDefault();
                if (this.busy || document.querySelector('dialog[open]')) {
                    this.message('현재 작업을 마친 뒤 파일을 놓으세요.');
                    return;
                }
                const f = e.dataTransfer.files[0];
                this.run(() => this.loadFile(f, true));
            }
        });
        new ResizeObserver(() => this.resizeView()).observe(this.workspace);
        const viewport = window.visualViewport;
        if (viewport) {
            let previousWidth = 0,
                previousHeight = 0,
                previousLayoutWidth = 0,
                previousLayoutHeight = 0;
            const updateViewport = () => {
                const { width, height, scale, offsetLeft, offsetTop } = viewport,
                    appHeight = Math.round(height * scale),
                    appWidth = Math.round(width * scale);
                if (
                    ![width, height, scale, offsetLeft, offsetTop, appHeight, appWidth].every(
                        Number.isFinite,
                    ) ||
                    width <= 0 ||
                    height <= 0 ||
                    scale <= 0 ||
                    appHeight <= 0 ||
                    appWidth <= 0
                )
                    return;
                const style = document.documentElement.style,
                    heightValue = appHeight + 'px',
                    spanChanged =
                        appWidth !== previousWidth ||
                        appHeight !== previousHeight ||
                        innerWidth !== previousLayoutWidth ||
                        innerHeight !== previousLayoutHeight,
                    follows = width >= Math.min(320, innerWidth) && height >= 160;
                // Freeze narrow pinch overlays during pan, but rebase them when the layout changes.
                if (follows || spanChanged) {
                    style.setProperty('--viewport-width', (follows ? width : appWidth) + 'px');
                    style.setProperty('--viewport-height', (follows ? height : appHeight) + 'px');
                    style.setProperty('--viewport-left', (follows ? offsetLeft : 0) + 'px');
                    style.setProperty('--viewport-top', (follows ? offsetTop : 0) + 'px');
                }
                style.setProperty('--panel-overscroll', follows ? 'contain' : 'auto');
                const unscaled = scale === 1 && Math.abs(width - innerWidth) <= 1,
                    leftValue =
                        (unscaled
                            ? offsetLeft
                            : spanChanged
                              ? 0
                              : parseFloat(style.getPropertyValue('--app-left')) || 0) + 'px',
                    topValue =
                        (unscaled
                            ? offsetTop
                            : spanChanged
                              ? 0
                              : parseFloat(style.getPropertyValue('--app-top')) || 0) + 'px',
                    changed =
                        style.getPropertyValue('--app-height') !== heightValue ||
                        style.getPropertyValue('--app-left') !== leftValue ||
                        style.getPropertyValue('--app-top') !== topValue;
                style.setProperty('--app-height', heightValue);
                style.setProperty('--app-left', leftValue);
                style.setProperty('--app-top', topValue);
                previousWidth = appWidth;
                previousHeight = appHeight;
                previousLayoutWidth = innerWidth;
                previousLayoutHeight = innerHeight;
                if (changed && this.viewWidth) this.resizeView();
            };
            viewport.addEventListener('resize', updateViewport);
            viewport.addEventListener('scroll', updateViewport);
            updateViewport();
        }
        try {
            const prefs = JSON.parse(localStorage.getItem('mypaint.ui.v1') || '{}');
            if (['studio', 'classic'].includes(prefs.skin)) this.skin = prefs.skin;
            if (['auto', 'touch', 'mouse'].includes(prefs.density)) this.density = prefs.density;
            this.eraserPreferences = readEraserPreferences(prefs.eraser);
        } catch {
            this.message('설정을 읽지 못했습니다. 기본 설정을 사용합니다.');
        }
        this.applyPreferences();
        window.addEventListener('mypaint-close-request', () =>
            this.run(async () => {
                if (!isDesktop()) return;
                if (this.nativeInitialized) {
                    if (this.busy || this.drag || this.doc.stroke || document.querySelector('dialog[open]')) {
                        this.message('진행 중인 작업을 완료하거나 취소한 뒤 닫으세요.');
                        return;
                    }
                    if (!(await this.replacementAllowed())) return;
                }
                const previousInert = this.root.inert;
                this.busy = true;
                this.root.inert = true;
                try {
                    await window.__TAURI__!.core.invoke('close_window');
                } catch (error) {
                    this.busy = false;
                    this.root.inert = previousInert;
                    throw error;
                }
            }),
        );
        matchMedia('(any-pointer: coarse)').addEventListener('change', () => {
            if (this.density !== 'auto') return;
            if (this.pointers.size || this.drag || this.doc.stroke || this.navigation)
                this.densityPending = true;
            else this.applyPreferences();
        });
        this.sync();
        this.resizeView();
        if (isDesktop()) {
            this.root.inert = true;
            const startup = document.createElement('dialog'),
                heading = document.createElement('h2'),
                message = document.createElement('p'),
                retry = document.createElement('button'),
                close = document.createElement('button');
            retry.textContent = '다시 시도';
            close.textContent = '앱 닫기';
            close.onclick = () =>
                this.run(async () => {
                    await window.__TAURI__!.core.invoke('close_window');
                });
            startup.addEventListener('cancel', (event) => event.preventDefault());
            startup.append(heading, message, retry, close);
            document.body.append(startup);
            startup.showModal();
            const prepare = () => {
                heading.textContent = '저장소 준비 중';
                message.textContent = '그림을 안전하게 저장할 준비를 하고 있습니다.';
                retry.disabled = true;
                this.nativeReady = activateNative(this.epoch, this.recovery.key).then(() => {
                    this.nativeInitialized = true;
                    this.root.inert = false;
                    startup.remove();
                });
                void this.nativeReady.catch((error) => {
                    heading.textContent = '저장소를 준비하지 못했습니다';
                    message.textContent = String(error) + ' 원인을 해결한 뒤 다시 시도하세요.';
                    retry.disabled = false;
                });
            };
            retry.onclick = prepare;
            prepare();
        }
        setInterval(() => this.autoRecover(), 30000);
        setTimeout(() => this.run(() => this.openRecovery(true)), 500);
    }
    color(hex: string): Color {
        return [
            parseInt(hex.slice(1, 3), 16),
            parseInt(hex.slice(3, 5), 16),
            parseInt(hex.slice(5, 7), 16),
            255,
        ];
    }
    hex(c: Color): string {
        return (
            '#' +
            c
                .slice(0, 3)
                .map((v) => v.toString(16).padStart(2, '0'))
                .join('')
        );
    }
    message(text: string): void {
        this.status.textContent = text;
    }
    async run(work: () => void | Promise<void>, ownsPointer = false): Promise<void> {
        try {
            await work();
        } catch (error) {
            if (ownsPointer) {
                this.cancelPointer();
                this.draw(true);
            }
            const text = error instanceof Error ? error.message : String(error);
            this.message(text);
            console.warn('myPaint operation failed', { message: text });
        } finally {
            this.sync();
            this.draw();
        }
    }
    hasPending(): boolean {
        return !!(
            this.drag?.mode === 'canvas-resize' ||
            this.selectionResize ||
            this.selectionPreparation ||
            this.selection ||
            this.editor ||
            this.points.length ||
            this.doc.stroke
        );
    }
    sync(layers = true): void {
        this.root.querySelector<HTMLButtonElement>('.resize-cancel')!.hidden = !this.selectionResize;
        this.title.textContent = this.name + (this.doc.dirty || this.hasPending() ? ' · 편집 중' : '');
        document.title = (this.doc.dirty ? '* ' : '') + this.name + ' — myPaint';
        for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-tool]'))
            b.setAttribute('aria-pressed', String(b.dataset.tool === this.tool));
        this.root.querySelector('.tool-name')!.textContent =
            toolDefinitions.find((t) => t[0] === this.tool)?.[1] || this.tool;
        this.root.querySelector('.document-info')!.textContent =
            `${this.doc.state.width} × ${this.doc.state.height} px`;
        this.root.querySelector<HTMLButtonElement>('[data-command=undo]')!.disabled =
            !this.doc.canUndo && !this.hasPending();
        this.root.querySelector<HTMLButtonElement>('[data-command=redo]')!.disabled =
            !this.doc.canRedo || this.hasPending();
        this.root.querySelector('#zoom')!.textContent = Math.round(this.zoom * 100) + '%';
        const layer = this.doc.state.active,
            count = this.doc.state.layers.length;
        this.root.querySelector<HTMLButtonElement>('[data-command=layer-delete]')!.disabled = count === 1;
        this.root.querySelector<HTMLButtonElement>('[data-command=layer-up]')!.disabled = layer === count - 1;
        this.root.querySelector<HTMLButtonElement>('[data-command=layer-down]')!.disabled = layer === 0;
        this.root.querySelector<HTMLButtonElement>('[data-command=layer-merge]')!.disabled = layer === 0;
        this.brushCursor.hidden = true;
        this.canvas.style.cursor =
            this.drag?.mode === 'canvas-resize'
                ? this.drag.canvasEdge === 'e'
                    ? 'ew-resize'
                    : this.drag.canvasEdge === 's'
                      ? 'ns-resize'
                      : 'nwse-resize'
                : this.tool === 'pan'
                  ? 'grab'
                  : this.tool === 'text'
                    ? 'text'
                    : 'crosshair';
        this.root.querySelector<HTMLSelectElement>('#eraser-mode')!.value = this.eraserPreferences.mode;
        const eraserInput = this.root.querySelector<HTMLInputElement>('#eraser-color')!;
        eraserInput.value = this.eraserPreferences.background;
        eraserInput.disabled = this.eraserPreferences.mode !== 'background';
        const pencil = this.tool === 'pencil',
            hardSquare = this.square && (this.tool === 'brush' || this.tool === 'eraser'),
            pixelHint = this.root.querySelector<HTMLElement>('.square-hint')!;
        pixelHint.hidden = !pencil && !hardSquare;
        pixelHint.textContent = pencil
            ? '연필은 1px 선을 그립니다. 크기·불투명도·경도·선 보정·필압 설정은 적용되지 않습니다.'
            : '사각 도구는 픽셀 경계가 선명한 선을 그립니다. 불투명도·경도·선 보정·필압 설정은 둥근 도구에 적용됩니다.';
        this.root.querySelector<HTMLInputElement>('#pressure')!.disabled = pencil || hardSquare;
        this.root.querySelector<HTMLInputElement>('#square')!.disabled = pencil;
        for (const id of ['size', 'opacity', 'hardness', 'stabilization']) {
            this.root.querySelector<HTMLInputElement>('#' + id)!.disabled =
                pencil || (hardSquare && id !== 'size');
            const value =
                id === 'size'
                    ? pencil
                        ? 1
                        : this.size
                    : id === 'opacity'
                      ? this.opacity
                      : id === 'hardness'
                        ? this.hardness
                        : this.stabilization;
            this.root.querySelector<HTMLInputElement>('#' + id)!.value = String(value);
            this.root.querySelector('#' + id + '-value')!.textContent =
                value + (id === 'size' ? ' px' : id === 'stabilization' ? '' : '%');
        }
        this.root.querySelector<HTMLInputElement>('#color')!.value = this.hex(this.foreground);
        if (document.activeElement !== this.root.querySelector('#hex'))
            this.root.querySelector<HTMLInputElement>('#hex')!.value = this.hex(this.foreground);
        this.root.querySelector<HTMLInputElement>('#secondary')!.value = this.hex(this.secondary);
        (this.root.querySelector('.color-preview') as HTMLElement).style.setProperty(
            '--ink',
            this.hex(this.foreground),
        );
        this.paintColorWheel();
        if (layers) {
            this.layerList.replaceChildren();
            for (let i = this.doc.state.layers.length - 1; i >= 0; i--) {
                const l = this.doc.state.layers[i],
                    row = document.createElement('div');
                row.className = 'layer-row' + (i === this.doc.state.active ? ' selected' : '');
                const check = document.createElement('input');
                check.type = 'checkbox';
                check.checked = l.visible;
                check.setAttribute('aria-label', l.name + ' 표시');
                check.onchange = () =>
                    this.run(() => {
                        if (this.busy || this.drag || this.doc.stroke)
                            throw Error('현재 작업을 마친 뒤 실행하세요.');
                        if (this.hasPending())
                            this.editPending('레이어 표시', (s) => {
                                s.layers[i].visible = check.checked;
                            });
                        else
                            this.doc.editMetadata('레이어 표시', {
                                kind: 'layer-visible',
                                layer: i,
                                visible: check.checked,
                            });
                        this.draw();
                    });
                const b = document.createElement('button');
                b.className = 'name';
                b.textContent = l.name;
                b.setAttribute('aria-pressed', String(i === this.doc.state.active));
                b.onclick = () =>
                    this.run(() => {
                        if (this.busy || this.drag || this.doc.stroke)
                            throw Error('현재 작업을 마친 뒤 실행하세요.');
                        this.settle();
                        this.doc.state.active = i;
                    });
                const visibility = document.createElement('label');
                visibility.className = 'layer-visibility';
                visibility.append(check);
                row.append(visibility, b);
                this.layerList.append(row);
            }
        }
    }
    createColorWheel(): void {
        const host = this.root.querySelector<HTMLElement>('.color-preview')!;
        host.style.background = 'none';
        const canvas = document.createElement('canvas');
        canvas.width = 440;
        canvas.height = 420;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.touchAction = 'none';
        canvas.setAttribute(
            'aria-label',
            '색상환과 채도·명도 선택. HEX 입력으로도 색상을 선택할 수 있습니다.',
        );
        this.wheel = canvas;
        host.append(canvas);
        const pick = (e: PointerEvent) => {
            if (this.busy) return;
            const rect = canvas.getBoundingClientRect(),
                x = ((e.clientX - rect.left) * 220) / rect.width,
                y = ((e.clientY - rect.top) * 210) / rect.height,
                dx = x - 110,
                dy = y - 105;
            if (e.type === 'pointerdown') {
                const distance = Math.hypot(dx, dy);
                this.colorDrag =
                    distance >= 82 && distance <= 105
                        ? 1
                        : x >= 54 && x <= 166 && y >= 49 && y <= 161
                          ? 2
                          : 0;
                if (this.colorDrag) canvas.setPointerCapture(e.pointerId);
            }
            if (!this.colorDrag) return;
            const [r, g, b] = this.foreground.map((v) => v / 255),
                max = Math.max(r, g, b),
                min = Math.min(r, g, b);
            let saturation = max ? (max - min) / max : 0,
                value = max;
            if (this.colorDrag === 1) this.hue = (Math.atan2(dy, dx) / (2 * Math.PI) + 1) % 1;
            else {
                saturation = Math.max(0, Math.min(1, (x - 54) / 112));
                value = Math.max(0, Math.min(1, 1 - (y - 49) / 112));
            }
            const h = this.hue * 6,
                k = Math.floor(h),
                f = h - k,
                p = value * (1 - saturation),
                q = value * (1 - f * saturation),
                t = value * (1 - (1 - f) * saturation),
                rgb = [
                    [value, t, p],
                    [q, value, p],
                    [p, value, t],
                    [p, q, value],
                    [t, p, value],
                    [value, p, q],
                ][k % 6];
            this.foreground = [
                Math.round(rgb[0] * 255),
                Math.round(rgb[1] * 255),
                Math.round(rgb[2] * 255),
                255,
            ];
            this.sync(false);
            if (e.type === 'pointerup' || e.type === 'pointercancel') this.colorDrag = 0;
        };
        canvas.onpointerdown = pick;
        canvas.onpointermove = pick;
        canvas.onpointerup = pick;
        canvas.onpointercancel = () => {
            this.colorDrag = 0;
        };
        canvas.onlostpointercapture = () => {
            this.colorDrag = 0;
        };
    }
    paintColorWheel(): void {
        const canvas = this.wheel;
        if (!canvas) return;
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(2, 0, 0, 2, 0, 0);
        ctx.clearRect(0, 0, 220, 210);
        const [r, g, b] = this.foreground.map((v) => v / 255),
            max = Math.max(r, g, b),
            min = Math.min(r, g, b),
            delta = max - min;
        if (delta) {
            const hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
            this.hue = (hue / 6 + 1) % 1;
        }
        const gradient = ctx.createConicGradient(0, 110, 105);
        for (let i = 0; i <= 6; i++) gradient.addColorStop(i / 6, `hsl(${i * 60} 100% 50%)`);
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 15;
        ctx.beginPath();
        ctx.arc(110, 105, 94, 0, Math.PI * 2);
        ctx.stroke();
        const saturation = ctx.createLinearGradient(54, 49, 166, 49);
        saturation.addColorStop(0, 'white');
        saturation.addColorStop(1, `hsl(${this.hue * 360} 100% 50%)`);
        ctx.fillStyle = saturation;
        ctx.fillRect(54, 49, 112, 112);
        const value = ctx.createLinearGradient(54, 49, 54, 161);
        value.addColorStop(0, 'transparent');
        value.addColorStop(1, 'black');
        ctx.fillStyle = value;
        ctx.fillRect(54, 49, 112, 112);
        const sx = 54 + (max ? delta / max : 0) * 112,
            sy = 49 + (1 - max) * 112;
        for (const [x, y] of [
            [sx, sy],
            [110 + Math.cos(this.hue * Math.PI * 2) * 94, 105 + Math.sin(this.hue * Math.PI * 2) * 94],
        ]) {
            ctx.lineWidth = 3;
            ctx.strokeStyle = '#000';
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#fff';
            ctx.stroke();
        }
    }
    applyPreferences(): void {
        this.densityPending = false;
        document.documentElement.dataset.skin = this.skin;
        document.documentElement.dataset.density =
            this.density === 'auto'
                ? matchMedia('(any-pointer: coarse)').matches
                    ? 'touch'
                    : 'mouse'
                : this.density;
        try {
            localStorage.setItem(
                'mypaint.ui.v1',
                JSON.stringify({ skin: this.skin, density: this.density, eraser: this.eraserPreferences }),
            );
        } catch {
            this.message('설정은 이번 세션에만 적용됩니다.');
        }
        this.draw();
    }
    resizeView(): void {
        if (this.densityPending && !this.pointers.size && !this.drag && !this.doc.stroke && !this.navigation)
            this.applyPreferences();
        const rect = this.workspace.getBoundingClientRect(),
            dpr = Math.min(devicePixelRatio || 1, 2),
            width = Math.max(1, Math.round(rect.width * dpr)),
            height = Math.max(1, Math.round(rect.height * dpr)),
            changed =
                rect.left !== this.viewLeft ||
                rect.top !== this.viewTop ||
                rect.width !== this.viewWidth ||
                rect.height !== this.viewHeight ||
                this.canvas.width !== width ||
                this.canvas.height !== height;
        if (this.drag || this.doc.stroke || this.navigation) {
            if (
                changed &&
                ((this.drag && !this.drag.resizeReleased && this.pointers.has(this.drag.pointer)) ||
                    (this.navigation && this.pointers.size > 0))
            )
                this.cancelPointer();
            return;
        }
        // A repeated observer must not undo the camera clamp for focused text.
        if (!changed && this.editor && this.editor === document.activeElement) return;
        const oldW = this.viewWidth,
            oldH = this.viewHeight;
        this.viewWidth = rect.width;
        this.viewHeight = rect.height;
        this.viewLeft = rect.left;
        this.viewTop = rect.top;
        if (this.canvas.width !== width) this.canvas.width = width;
        if (this.canvas.height !== height) this.canvas.height = height;
        if (this.autoFit) this.fit();
        else {
            this.offsetX += (this.viewWidth - oldW) / 2;
            this.offsetY += (this.viewHeight - oldH) / 2;
            this.draw();
        }
        if (this.editor === document.activeElement && this.textPoint) {
            const editor = this.editor!,
                left = this.offsetX + this.textPoint.x * this.zoom,
                top = this.offsetY + this.textPoint.y * this.zoom;
            // Keep the leading edge visible when a zoomed text box cannot fit in the viewport.
            this.offsetX +=
                Math.max(8, Math.min(left, this.viewWidth - editor.offsetWidth * this.zoom - 8)) - left;
            this.offsetY +=
                Math.max(8, Math.min(top, this.viewHeight - editor.offsetHeight * this.zoom - 8)) - top;
            this.placeEditor();
        }
    }
    fit(): void {
        const s = this.doc.state;
        this.zoom = Math.max(
            minZoom,
            Math.min(1, (this.viewWidth - 32) / s.width, (this.viewHeight - 32) / s.height),
        );
        this.offsetX = (this.viewWidth - s.width * this.zoom) / 2;
        this.offsetY = (this.viewHeight - s.height * this.zoom) / 2;
        this.autoFit = true;
        this.sync(false);
        this.draw();
    }
    changeZoom(zoom: number, x = this.viewWidth / 2, y = this.viewHeight / 2): void {
        const nx = (x - this.offsetX) / this.zoom,
            ny = (y - this.offsetY) / this.zoom;
        this.zoom = Math.max(minZoom, Math.min(16, zoom));
        this.offsetX = x - nx * this.zoom;
        this.offsetY = y - ny * this.zoom;
        this.autoFit = false;
        this.sync(false);
        this.draw();
    }
    draw(full = false, pixels?: Uint8ClampedArray, rectangles?: Iterable<PixelRect>): void {
        const canvasDrag = this.drag?.mode === 'canvas-resize' ? this.drag : undefined,
            width = canvasDrag?.canvasWidth ?? this.doc.state.width,
            height = canvasDrag?.canvasHeight ?? this.doc.state.height;
        this.canvasBounds.hidden =
            !this.nativeInitialized ||
            this.busy ||
            !!this.doc.stroke ||
            !!this.selectionResize ||
            !!this.selectionPreparation ||
            (!!this.drag && !canvasDrag);
        this.canvasBounds.classList.toggle('resizing', !!canvasDrag);
        this.canvasBounds.style.left = this.offsetX + 'px';
        this.canvasBounds.style.top = this.offsetY + 'px';
        this.canvasBounds.style.width = width * this.zoom + 'px';
        this.canvasBounds.style.height = height * this.zoom + 'px';
        this.canvasBounds.querySelector('output')!.textContent = width + ' × ' + height + ' px';
        if (this.busy) this.brushCursor.hidden = true;
        this.fullPixels ||= full;
        if (this.fullPixels) this.pendingDirty.clear();
        else if (pixels && rectangles) {
            const pending = this.pendingDirty.get(pixels) || [];
            for (const { x, y, width, height } of rectangles) {
                pending.push({ x, y, width, height });
                if (pending.length > 4096) {
                    this.fullPixels = true;
                    this.pendingDirty.clear();
                    break;
                }
            }
            if (!this.fullPixels) this.pendingDirty.set(pixels, pending);
        }
        if (!this.frame)
            this.frame = requestAnimationFrame(() => {
                this.frame = 0;
                this.renderFrame();
            });
    }
    private renderFrame(): void {
        try {
            this.render(true);
        } catch (error) {
            this.cancelRenderPreparation();
            this.sceneCache.clear();
            this.pendingDirty.clear();
            if (this.renderPainting) this.canvas.width = this.canvas.width;
            this.renderPainting = false;
            this.fullPixels = true;
            this.renderPending = true;
            this.canvas.dataset.ready = 'false';
            this.canvas.removeAttribute('aria-busy');
            this.message('화면 표시 실패: ' + (error instanceof Error ? error.message : String(error)));
            console.warn('myPaint rendering failed', error);
        }
    }
    cancelRenderPreparation(): void {
        const pending = this.renderPreparation;
        this.renderPreparation = undefined;
        if (!pending) return;
        if (pending.channel) {
            pending.channel.port1.onmessage = null;
            pending.channel.port1.close();
            pending.channel.port2.close();
        }
        pending.source.cancelPrepare();
    }
    render(cooperative = false): void {
        if (!cooperative) this.cancelRenderPreparation();
        if (this.renderContextLost || this.ctx.isContextLost?.()) {
            this.cancelRenderPreparation();
            this.renderPending = true;
            this.canvas.dataset.ready = 'false';
            return;
        }
        const { ctx } = this,
            s = this.doc.state,
            paperWidth = Math.max(s.width, (this.selection?.x ?? 0) + (this.selection?.width ?? 0)),
            paperHeight = Math.max(s.height, (this.selection?.y ?? 0) + (this.selection?.height ?? 0)),
            dpr = this.canvas.width / Math.max(1, this.viewWidth),
            background = getComputedStyle(document.documentElement).getPropertyValue('--bg'),
            checker = '#dde0e5';
        const viewport = {
                x: -this.offsetX / this.zoom,
                y: -this.offsetY / this.zoom,
                width: this.viewWidth / this.zoom,
                height: this.viewHeight / this.zoom,
            },
            owners: object[] = s.layers.filter((layer) => layer.visible).map((layer) => layer.pixels),
            rasters: SceneRaster[] = [];
        for (let i = 0; i < s.layers.length; i++) {
            const layer = s.layers[i];
            if (!layer.visible && !(i === s.active && this.selection?.modified)) continue;
            const dirty = this.fullPixels
                ? 'all'
                : this.doc.stroke?.layer === i
                  ? [
                        ...(this.pendingDirty.get(layer.pixels) || []),
                        ...[...this.doc.stroke.dirty].map((key) => this.doc.stroke!.tiles.get(key)!),
                    ]
                  : this.pendingDirty.get(layer.pixels);
            if (i === s.active && this.selection?.modified) {
                const sel = this.selection;
                let preview = this.selectionCache;
                if (
                    !preview ||
                    preview.selection !== sel ||
                    preview.pixels !== sel.pixels ||
                    preview.revision !== this.doc.revision
                ) {
                    preview = {
                        selection: sel,
                        pixels: sel.pixels,
                        revision: this.doc.revision,
                        cutOwner: {},
                    };
                    this.selectionCache = preview;
                }
                owners.push(preview.cutOwner, sel.pixels);
                rasters.push({
                    owner: preview.cutOwner,
                    pixels: layer.pixels,
                    width: s.width,
                    height: s.height,
                    dirty,
                    transform: (pixels, x, y, width, height) => {
                        const source = sel.source;
                        if (!source) return;
                        const left = Math.max(0, Math.ceil(source.x - x)),
                            right = Math.min(width, Math.ceil(source.x + source.width - x)),
                            top = Math.max(0, Math.ceil(source.y - y)),
                            bottom = Math.min(height, Math.ceil(source.y + source.height - y));
                        if (left >= right || top >= bottom) return;
                        const target = s.layers.length === 1 ? s.background : [0, 0, 0, 0],
                            mask = sel.sourceMask;
                        for (let row = top; row < bottom; row++) {
                            const sy = y + row - source.y;
                            let i = (row * width + left) * 4;
                            for (let col = left; col < right; col++, i += 4) {
                                const sx = x + col - source.x;
                                if (mask && !mask[sy * source.width + sx]) continue;
                                pixels[i] = target[0];
                                pixels[i + 1] = target[1];
                                pixels[i + 2] = target[2];
                                pixels[i + 3] = target[3];
                            }
                        }
                    },
                });
                rasters.push({
                    owner: sel.pixels,
                    pixels: sel.pixels,
                    width: sel.width,
                    height: sel.height,
                    x: sel.x,
                    y: sel.y,
                });
            } else {
                rasters.push({
                    owner: layer.pixels,
                    pixels: layer.pixels,
                    width: s.width,
                    height: s.height,
                    dirty,
                });
            }
        }
        if (cooperative && dpr * this.zoom < 1) {
            const sel = this.selection,
                key: unknown[] = [
                    this.epoch,
                    s,
                    s.width,
                    s.height,
                    paperWidth,
                    paperHeight,
                    this.canvas,
                    this.canvas.width,
                    this.canvas.height,
                    this.viewWidth,
                    this.viewHeight,
                    this.zoom,
                    this.offsetX,
                    this.offsetY,
                    background,
                    checker,
                    ...s.background,
                    sel,
                    sel?.source,
                    sel?.sourceMask,
                    sel?.source?.x,
                    sel?.source?.y,
                    sel?.source?.width,
                    sel?.source?.height,
                ];
            for (const raster of rasters)
                key.push(
                    raster.owner,
                    raster.pixels,
                    raster.width,
                    raster.height,
                    raster.x ?? 0,
                    raster.y ?? 0,
                    !!raster.transform,
                );
            const changed = rasters.some((raster) => raster.dirty === 'all' || !!raster.dirty?.length);
            let pending = this.renderPreparation;
            if (
                pending &&
                (pending.source !== this.sceneCache.source ||
                    changed ||
                    pending.key.length !== key.length ||
                    key.some((value, i) => value !== pending!.key[i]))
            ) {
                this.cancelRenderPreparation();
                pending = undefined;
            }
            if (!pending) {
                const source = this.sceneCache.fallbackSource();
                if (
                    rasters.length > source.maxTiles ||
                    rasters.filter((raster) => raster.transform).length > 1
                )
                    throw Error('현재 화면의 준비 작업이 렌더 예산을 초과했습니다.');
                source.beginFrame(rasters.length);
                source.retain(owners);
                for (const raster of rasters) {
                    source.invalidate(raster.owner, raster.dirty);
                    raster.dirty = undefined;
                }
                // Dirty ownership is now in the cache, including offscreen retained tiles.
                // A new edit populates a fresh batch while this preparation is suspended.
                this.doc.stroke?.dirty.clear();
                this.pendingDirty.clear();
                this.fullPixels = false;
                ctx.save();
                let matrix: DOMMatrix;
                try {
                    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                    ctx.translate(this.offsetX, this.offsetY);
                    ctx.scale(this.zoom, this.zoom);
                    matrix = ctx.getTransform();
                } finally {
                    ctx.restore();
                }
                pending = {
                    key,
                    source,
                    matrix,
                    viewport,
                    index: 0,
                    announced: false,
                    queued: false,
                    // At most one cut transform exists. Its larger scratch lease is prepared first.
                    rasters: [
                        ...rasters.filter((raster) => raster.transform),
                        ...rasters.filter((raster) => !raster.transform),
                    ],
                };
                this.renderPreparation = pending;
            }
            const deadline = performance.now() + 4;
            while (pending.index < pending.rasters.length) {
                const raster = pending.rasters[pending.index];
                if (
                    pending.source.prepare(
                        ctx,
                        raster.owner,
                        raster.pixels,
                        raster.width,
                        raster.height,
                        pending.viewport,
                        undefined,
                        raster.x,
                        raster.y,
                        raster.transform,
                        pending.matrix,
                    )
                )
                    pending.index++;
                if (performance.now() >= deadline) break;
            }
            if (pending.index < pending.rasters.length) {
                this.renderPending = true;
                this.canvas.dataset.ready = 'false';
                this.canvas.setAttribute('aria-busy', 'true');
                if (!pending.announced && !this.busy) {
                    this.message('화면 준비 중…');
                    pending.announced = true;
                }
                if (!pending.channel) {
                    const current = pending;
                    pending.channel = new MessageChannel();
                    pending.channel.port1.onmessage = () => {
                        current.queued = false;
                        if (this.renderPreparation === current && !this.frame) this.renderFrame();
                    };
                }
                if (!pending.queued) {
                    pending.queued = true;
                    pending.channel.port2.postMessage(null);
                }
                return;
            }
            this.cancelRenderPreparation();
        } else if (this.renderPreparation) this.cancelRenderPreparation();
        this.renderPainting = true;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.save();
        ctx.translate(this.offsetX, this.offsetY);
        ctx.scale(this.zoom, this.zoom);
        ctx.imageSmoothingEnabled = this.zoom < 1;
        const missing = this.sceneCache.prepare(
                ctx,
                { zoom: this.zoom, paperWidth, paperHeight, background, checker, viewport },
                rasters,
            ),
            tiles = this.sceneCache.source;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, paperWidth, paperHeight);
        ctx.clip();
        if (missing) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, paperWidth, paperHeight);
            const step = 12 / this.zoom;
            ctx.fillStyle = checker;
            const x0 = Math.max(0, Math.floor(-this.offsetX / this.zoom / step)),
                x1 = Math.min(
                    Math.ceil(paperWidth / step),
                    Math.ceil((this.viewWidth - this.offsetX) / this.zoom / step),
                ),
                y0 = Math.max(0, Math.floor(-this.offsetY / this.zoom / step)),
                y1 = Math.min(
                    Math.ceil(paperHeight / step),
                    Math.ceil((this.viewHeight - this.offsetY) / this.zoom / step),
                );
            for (let y = y0; y < y1; y++)
                for (let x = x0; x < x1; x++)
                    if ((x + y) % 2 === 0) ctx.fillRect(x * step, y * step, step, step);
            for (const raster of rasters)
                tiles.draw(
                    ctx,
                    raster.owner,
                    raster.pixels,
                    raster.width,
                    raster.height,
                    missing,
                    undefined,
                    raster.x,
                    raster.y,
                    raster.transform,
                );
        }
        tiles.retain(owners);
        ctx.restore();
        this.sceneCache.finish(ctx);
        if (this.selection) {
            const q = this.selection,
                width = this.selectionResize?.width ?? q.width,
                height = this.selectionResize?.height ?? q.height;
            ctx.strokeStyle = '#1679ea';
            ctx.lineWidth = 1 / this.zoom;
            ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
            ctx.strokeRect(q.x, q.y, width, height);
            ctx.setLineDash([]);
            ctx.fillStyle = '#1679ea';
            ctx.fillRect(
                q.x + width - 4 / this.zoom,
                q.y + height - 4 / this.zoom,
                8 / this.zoom,
                8 / this.zoom,
            );
        }
        if (this.drag && ['select', 'lasso'].includes(this.drag.mode)) {
            ctx.strokeStyle = '#1679ea';
            ctx.lineWidth = 1 / this.zoom;
            ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
            if (this.drag.mode === 'select')
                ctx.strokeRect(
                    this.drag.start.x,
                    this.drag.start.y,
                    this.drag.last.x - this.drag.start.x,
                    this.drag.last.y - this.drag.start.y,
                );
            else {
                ctx.beginPath();
                for (const [i, p] of this.points.entries())
                    if (i === 0) ctx.moveTo(p.x, p.y);
                    else ctx.lineTo(p.x, p.y);
                ctx.stroke();
            }
            ctx.setLineDash([]);
        }
        if (this.drag && ['line', 'curve', 'rectangle', 'roundrect', 'ellipse'].includes(this.drag.mode))
            this.paintShape(ctx, this.drag.start, this.drag.last, this.drag.mode);
        if (
            this.tool === 'curve' &&
            this.points.length === 2 &&
            (!this.drag || this.drag.mode === 'curve-control')
        )
            this.paintShape(ctx, this.points[0], this.points[1], 'curve');
        if (this.tool === 'polygon' && this.points.length)
            this.paintShape(ctx, this.points[0], this.points[this.points.length - 1], 'polygon');
        ctx.restore();
        if (this.renderContextLost || ctx.isContextLost?.()) {
            this.cancelRenderPreparation();
            this.sceneCache.clear();
            this.fullPixels = true;
            this.renderPending = true;
            this.renderPainting = false;
            this.canvas.dataset.ready = 'false';
            return;
        }
        this.placeEditor();
        this.doc.stroke?.dirty.clear();
        this.pendingDirty.clear();
        this.fullPixels = false;
        this.renderPainting = false;
        this.canvas.dataset.ready = this.selectionResize ? 'false' : 'true';
        if (this.selectionResize) this.canvas.setAttribute('aria-busy', 'true');
        else this.canvas.removeAttribute('aria-busy');
        this.renderPending = false;
        if (
            this.status.textContent === '화면 준비 중…' ||
            this.status.textContent === '화면을 준비하고 있습니다. 화면 이동·확대·축소는 사용할 수 있습니다.'
        )
            this.message('화면을 갱신했습니다.');
    }
    point(e: PointerEvent, r = this.canvas.getBoundingClientRect()): Point {
        return {
            x: (e.clientX - r.left - this.offsetX) / this.zoom,
            y: (e.clientY - r.top - this.offsetY) / this.zoom,
            pressure: e.pointerType === 'pen' ? e.pressure : 1,
        };
    }
    async pointerDown(e: PointerEvent): Promise<void> {
        if (
            !this.nativeInitialized ||
            this.selectionResize?.drag.resizeReleased ||
            this.busy ||
            document.querySelector('dialog[open]') ||
            this.pointers.has(e.pointerId) ||
            (e.pointerType === 'mouse' && (e.button < 0 || e.button > 2))
        )
            return;
        const bounds = this.canvas.getBoundingClientRect(),
            dpr = Math.min(devicePixelRatio || 1, 2);
        if (
            bounds.left !== this.viewLeft ||
            bounds.top !== this.viewTop ||
            bounds.width !== this.viewWidth ||
            bounds.height !== this.viewHeight ||
            this.canvas.width !== Math.max(1, Math.round(bounds.width * dpr)) ||
            this.canvas.height !== Math.max(1, Math.round(bounds.height * dpr))
        )
            this.resizeView();
        e.preventDefault();
        this.canvas.focus();
        this.canvas.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
        if (this.pointers.size === 2 && [...this.pointers.values()].every((p) => p.type === 'touch')) {
            // Restore the temporary edit while retaining both touch owners for navigation.
            this.cancelPointer(undefined, true);
            const [a, b] = [...this.pointers.values()],
                r = this.canvas.getBoundingClientRect(),
                cx = (a.x + b.x) / 2 - r.left,
                cy = (a.y + b.y) / 2 - r.top;
            this.navigation = {
                distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
                zoom: this.zoom,
                anchorX: (cx - this.offsetX) / this.zoom,
                anchorY: (cy - this.offsetY) / this.zoom,
            };
            this.draw();
            return;
        }
        if (this.pointers.size > 1) return;
        this.mouseButtonMask = e.pointerType === 'mouse' ? [1, 4, 2][e.button] || 0 : 0;
        const p = this.point(e),
            canvasEdge =
                e.target instanceof Element
                    ? e.target.closest<HTMLElement>('[data-canvas-resize]')?.dataset.canvasResize
                    : undefined;
        if (canvasEdge) {
            if (e.button !== 0 || this.selectionResize || this.selectionPreparation) {
                this.cancelPointer(e.pointerId);
                return;
            }
            this.drag = {
                pointer: e.pointerId,
                mode: 'canvas-resize',
                start: p,
                last: p,
                offsetX: 0,
                offsetY: 0,
                canvasEdge,
                canvasWidth: this.doc.state.width,
                canvasHeight: this.doc.state.height,
                canvasOwner: this.doc.state,
                canvasRevision: this.doc.revision,
                canvasEpoch: this.epoch,
            };
            this.sync(false);
            this.draw();
            return;
        }
        if (e.button === 1 || this.tool === 'pan' || (e.pointerType === 'touch' && !this.fingerDraw)) {
            this.drag = {
                pointer: e.pointerId,
                mode: 'pan',
                start: p,
                last: p,
                offsetX: e.clientX - this.offsetX,
                offsetY: e.clientY - this.offsetY,
            };
            return;
        }
        if (this.renderPending) {
            this.message('화면을 준비하고 있습니다. 화면 이동·확대·축소는 사용할 수 있습니다.');
            return;
        }
        if (
            this.selection &&
            ['select', 'lasso'].includes(this.tool) &&
            p.x >= this.selection.x &&
            p.y >= this.selection.y &&
            p.x <= this.selection.x + this.selection.width &&
            p.y <= this.selection.y + this.selection.height
        ) {
            const q = this.selection;
            this.drag = {
                pointer: e.pointerId,
                mode:
                    Math.abs(p.x - q.x - q.width) < 12 / this.zoom &&
                    Math.abs(p.y - q.y - q.height) < 12 / this.zoom
                        ? 'resize-selection'
                        : 'move-selection',
                start: p,
                last: p,
                offsetX: p.x - q.x,
                offsetY: p.y - q.y,
                selectionX: q.x,
                selectionY: q.y,
                selectionModified: q.modified,
                selectionRaster: { width: q.width, height: q.height, pixels: q.pixels },
                selectionResizeSource: q.resizeSource,
            };
            return;
        }
        const shape = ['line', 'curve', 'rectangle', 'roundrect', 'ellipse', 'polygon'].includes(this.tool),
            previousShapeSecondary = this.shapeSecondary;
        if (shape) this.shapeSecondary = e.button === 2;
        if (this.tool === 'curve' && this.points.length === 2) {
            this.drag = {
                pointer: e.pointerId,
                mode: 'curve-control',
                start: p,
                last: p,
                offsetX: 0,
                offsetY: 0,
                previousShapeSecondary,
            };
            this.draw();
            return;
        }
        if (this.tool === 'polygon' && this.points.length) {
            this.drag = {
                pointer: e.pointerId,
                mode: 'polygon-point',
                start: p,
                last: p,
                offsetX: 0,
                offsetY: 0,
                previousShapeSecondary,
            };
            this.draw();
            return;
        }
        this.settle();
        const color = e.button === 2 ? this.secondary : this.foreground;
        if (this.tool === 'picker') {
            const x = Math.floor(p.x),
                y = Math.floor(p.y),
                s = this.doc.state;
            if (x >= 0 && y >= 0 && x < s.width && y < s.height) {
                const i = (y * s.width + x) * 4;
                const color: [number, number, number, number] = [0, 0, 0, 0];
                for (const layer of s.layers) {
                    if (!layer.visible) continue;
                    const a = layer.pixels[i + 3] / 255;
                    if (!a) continue;
                    const b = color[3] / 255,
                        alpha = a + b * (1 - a);
                    for (let c = 0; c < 3; c++)
                        color[c] = Math.round((layer.pixels[i + c] * a + color[c] * b * (1 - a)) / alpha);
                    color[3] = Math.round(alpha * 255);
                }
                this.foreground = color;
                this.sync(false);
            }
            return;
        }
        if (this.tool === 'fill') {
            const state = this.doc.state,
                x = Math.floor(p.x),
                y = Math.floor(p.y);
            if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
            const active = state.active,
                revision = this.doc.revision,
                epoch = this.epoch;
            const input: State = {
                ...state,
                active: 0,
                layers: [
                    { ...state.layers[state.active], pixels: state.layers[state.active].pixels.slice() },
                ],
            };
            await this.task('색상 처리 중', async (signal) => {
                const result = await runCodec(
                    'fill',
                    input,
                    Uint8Array.of(x & 255, x >>> 8, y & 255, y >>> 8, ...color),
                    signal,
                    runtimeProfile,
                );
                if (
                    signal.aborted ||
                    this.doc.state !== state ||
                    this.doc.revision !== revision ||
                    this.epoch !== epoch ||
                    state.active !== active
                )
                    throw Error('편집 상태가 변경되어 색상 처리를 적용하지 않았습니다.');
                if (result.image) {
                    const image = result.image as Raster & { left: number; top: number };
                    this.doc.replacePixels(
                        '색상 처리',
                        active,
                        image.left,
                        image.top,
                        image.width,
                        image.height,
                        image.pixels,
                    );
                    this.draw(true);
                }
            });
            return;
        }
        if (this.tool === 'text') {
            this.beginText(p);
            return;
        }
        if (this.tool === 'polygon') {
            this.drag = {
                pointer: e.pointerId,
                mode: 'polygon-point',
                start: p,
                last: p,
                offsetX: 0,
                offsetY: 0,
                previousShapeSecondary,
            };
            this.draw();
            return;
        }
        this.drag = {
            pointer: e.pointerId,
            mode: this.tool,
            start: p,
            last: p,
            offsetX: 0,
            offsetY: 0,
            previousShapeSecondary: shape ? previousShapeSecondary : undefined,
        };
        if (['brush', 'pencil', 'eraser', 'spray', 'color-eraser'].includes(this.tool)) {
            const eraser = this.tool === 'eraser',
                matchColor = this.tool === 'color-eraser' ? this.foreground : undefined;
            const settings = {
                color: matchColor ? this.secondary : eraser ? eraserColor(this.eraserPreferences) : color,
                size: this.tool === 'pencil' || this.tool === 'spray' ? 1 : this.size,
                opacity: this.opacity / 100,
                hardness: this.tool === 'pencil' || this.tool === 'spray' ? 1 : this.hardness / 100,
                stabilization: this.tool === 'pencil' || this.tool === 'spray' ? 0 : this.stabilization,
                eraser,
                pressure: e.pointerType === 'pen' && this.pressure,
                square: this.tool === 'pencil' || this.square,
                pixel: this.tool === 'spray',
                dabsOnly: this.tool === 'spray',
                matchColor,
            };
            this.doc.beginStroke(p.x, p.y, settings, p.pressure);
            if (this.tool === 'spray')
                this.sprayTimer = setInterval(() => {
                    if (!this.drag) return;
                    try {
                        const p = this.drag.last;
                        for (let n = 0; n < this.size * 2; n++) {
                            const a = Math.random() * Math.PI * 2,
                                r = Math.sqrt(Math.random()) * this.size;
                            this.doc.moveStroke(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 1, true);
                        }
                        this.draw();
                    } catch (error) {
                        this.run(() => {
                            throw error;
                        }, true);
                    }
                }, 35);
        } else if (this.tool === 'lasso')
            this.points = [{ x: Math.floor(p.x), y: Math.floor(p.y), pressure: p.pressure }];
        this.sync(false);
        this.draw();
    }
    pointerMove(e: PointerEvent, finishing = false): void {
        if (!this.pointers.has(e.pointerId)) return;
        const bounds = this.canvas.getBoundingClientRect(),
            dpr = Math.min(devicePixelRatio || 1, 2);
        if (
            bounds.left !== this.viewLeft ||
            bounds.top !== this.viewTop ||
            bounds.width !== this.viewWidth ||
            bounds.height !== this.viewHeight ||
            this.canvas.width !== Math.max(1, Math.round(bounds.width * dpr)) ||
            this.canvas.height !== Math.max(1, Math.round(bounds.height * dpr))
        ) {
            this.resizeView();
            if (!this.pointers.has(e.pointerId)) return;
        }
        // Chorded mouse releases may arrive as pointermove until the last button is up.
        if (
            !finishing &&
            e.pointerType === 'mouse' &&
            this.drag?.pointer === e.pointerId &&
            this.mouseButtonMask
        ) {
            if (!(e.buttons & this.mouseButtonMask)) {
                this.pointerUp(e);
                return;
            }
            if (e.button >= 0 && [1, 4, 2][e.button] !== this.mouseButtonMask) {
                const settings = this.doc.stroke?.settings;
                // Another button changing state is not a square drawing move.
                if (settings?.square && !settings.pixel && !settings.dabsOnly && !settings.matchColor) return;
            }
        }
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
        if (this.navigation) {
            if (this.pointers.size >= 2) {
                const [a, b] = [...this.pointers.values()],
                    r = bounds;
                this.zoom = Math.max(
                    minZoom,
                    Math.min(
                        16,
                        (this.navigation.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / this.navigation.distance,
                    ),
                );
                this.offsetX = (a.x + b.x) / 2 - r.left - this.navigation.anchorX * this.zoom;
                this.offsetY = (a.y + b.y) / 2 - r.top - this.navigation.anchorY * this.zoom;
                this.autoFit = false;
                this.sync(false);
                this.draw();
            }
            return;
        }
        const drag = this.drag;
        if (!drag || drag.pointer !== e.pointerId) return;
        const p = this.point(e, bounds);
        if (e.shiftKey && ['line', 'rectangle', 'roundrect', 'ellipse'].includes(drag.mode)) {
            const dx = p.x - drag.start.x,
                dy = p.y - drag.start.y;
            if (drag.mode === 'line') {
                const delta = snapLineDelta(dx, dy);
                p.x = drag.start.x + delta.x;
                p.y = drag.start.y + delta.y;
            } else {
                const size = Math.max(Math.abs(dx), Math.abs(dy));
                p.x = drag.start.x + Math.sign(dx || 1) * size;
                p.y = drag.start.y + Math.sign(dy || 1) * size;
            }
        }
        drag.last = p;
        if (drag.mode === 'canvas-resize') {
            const owner = drag.canvasOwner!,
                width = Math.max(
                    1,
                    Math.min(
                        runtimeProfile.dimension,
                        owner.width + (drag.canvasEdge!.includes('e') ? Math.round(p.x - drag.start.x) : 0),
                    ),
                ),
                height = Math.max(
                    1,
                    Math.min(
                        runtimeProfile.dimension,
                        owner.height + (drag.canvasEdge!.includes('s') ? Math.round(p.y - drag.start.y) : 0),
                    ),
                );
            try {
                validateSize(width, height, owner.layers.length, runtimeProfile);
            } catch (error) {
                this.message(error instanceof Error ? error.message : String(error));
                return;
            }
            drag.canvasWidth = width;
            drag.canvasHeight = height;
            this.message(`캔버스 ${width} × ${height} px · 놓으면 적용 · Esc 취소`);
        } else if (drag.mode === 'pan') {
            this.offsetX = e.clientX - drag.offsetX;
            this.offsetY = e.clientY - drag.offsetY;
            this.autoFit = false;
        } else if (drag.mode === 'move-selection' && this.selection) {
            const x = Math.round(p.x - drag.offsetX),
                y = Math.round(p.y - drag.offsetY);
            validateSize(
                Math.max(this.doc.state.width, x + this.selection.width),
                Math.max(this.doc.state.height, y + this.selection.height),
                this.doc.state.layers.length,
                runtimeProfile,
            );
            this.selection.x = x;
            this.selection.y = y;
            const q = this.selection;
            q.modified =
                !q.source ||
                q.x !== q.source.x ||
                q.y !== q.source.y ||
                q.width !== q.source.width ||
                q.height !== q.source.height ||
                q.pixels !== q.originalPixels;
        } else if (drag.mode === 'resize-selection' && this.selection) {
            const q = this.selection,
                w = Math.max(1, Math.round(p.x - q.x)),
                h = Math.max(1, Math.round(p.y - q.y));
            validateSize(w, h, 1, runtimeProfile);
            validateSize(
                Math.max(this.doc.state.width, q.x + w),
                Math.max(this.doc.state.height, q.y + h),
                this.doc.state.layers.length,
                runtimeProfile,
            );
            const original = drag.selectionRaster!,
                base = drag.selectionResizeSource || original,
                pending = this.selectionResize;
            if (
                pending?.drag === drag &&
                ((w === q.width && h === q.height) ||
                    (w === original.width && h === original.height) ||
                    (w === base.width && h === base.height))
            ) {
                this.selectionResize = undefined;
                pending.cancel?.();
                this.message('선택 크기를 변경했습니다.');
            }
            if (w !== q.width || h !== q.height) {
                if (this.selectionResize?.drag === drag) {
                    this.selectionResize.width = w;
                    this.selectionResize.height = h;
                } else if (
                    w * h >= 262144 &&
                    !(w === original.width && h === original.height) &&
                    !(w === base.width && h === base.height)
                ) {
                    void this.run(() => this.resizeSelection(w, h));
                } else {
                    if (w === original.width && h === original.height) {
                        q.width = w;
                        q.height = h;
                        q.pixels = original.pixels;
                        q.modified = drag.selectionModified!;
                        q.resizeSource = drag.selectionResizeSource;
                    } else {
                        const pixels =
                            w === base.width && h === base.height
                                ? base.pixels
                                : resizeState(
                                      {
                                          width: base.width,
                                          height: base.height,
                                          background: [0, 0, 0, 0],
                                          active: 0,
                                          layers: [{ name: 'selection', visible: true, pixels: base.pixels }],
                                      },
                                      w,
                                      h,
                                      true,
                                      false,
                                      runtimeProfile,
                                  ).layers[0].pixels;
                        q.width = w;
                        q.height = h;
                        q.pixels = pixels;
                        q.resizeSource = base;
                        q.modified =
                            !q.source ||
                            q.x !== q.source.x ||
                            q.y !== q.source.y ||
                            q.width !== q.source.width ||
                            q.height !== q.source.height ||
                            q.pixels !== q.originalPixels;
                    }
                }
            }
        } else if (this.doc.stroke && drag.mode !== 'spray') {
            const settings = this.doc.stroke.settings,
                hardSquare = settings.square && !settings.pixel && !settings.dabsOnly && !settings.matchColor,
                events =
                    !(finishing && hardSquare && e.button >= 0) && typeof e.getCoalescedEvents === 'function'
                        ? e.getCoalescedEvents()
                        : [];
            // endStroke handles the terminal square segment once; actual coalesced moves still paint.
            for (const sample of events.length ? events : finishing && hardSquare ? [] : [e]) {
                const point = this.point(sample, bounds);
                // A pen release reports no contact force; finish with the last drawing pressure.
                const pressure =
                    finishing && sample.pointerType === 'pen' && point.pressure === 0
                        ? this.doc.stroke.pressure
                        : point.pressure;
                this.doc.moveStroke(point.x, point.y, pressure);
            }
        } else if (drag.mode === 'lasso') {
            const x = Math.floor(p.x),
                y = Math.floor(p.y),
                last = this.points.at(-1);
            if (!last || last.x !== x || last.y !== y) this.points.push({ x, y, pressure: p.pressure });
        }
        this.draw();
    }
    pointerUp(e: PointerEvent): void {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointerMove(e, true);
        this.pointers.delete(e.pointerId);
        if (this.navigation) {
            if (!this.pointers.size) {
                this.navigation = undefined;
                this.resizeView();
            }
            return;
        }
        const drag = this.drag;
        if (!drag || drag.pointer !== e.pointerId) {
            if (this.densityPending && !this.pointers.size) this.resizeView();
            return;
        }
        this.mouseButtonMask = 0;
        this.stopSpray();
        if (drag.mode === 'canvas-resize') {
            this.drag = undefined;
            this.sync(false);
            this.draw();
            if (
                drag.canvasOwner !== this.doc.state ||
                drag.canvasRevision !== this.doc.revision ||
                drag.canvasEpoch !== this.epoch
            )
                throw Error('편집 상태가 변경되어 캔버스 크기를 바꾸지 않았습니다.');
            if (drag.canvasWidth === this.doc.state.width && drag.canvasHeight === this.doc.state.height)
                return;
            void this.run(async () => {
                await this.editDocument(
                    '캔버스 크기 변경',
                    { kind: 'resize', width: drag.canvasWidth!, height: drag.canvasHeight!, scale: false },
                    false,
                );
                this.autoFit = false;
                this.message(
                    `캔버스 ${this.doc.state.width} × ${this.doc.state.height} px · 실행 취소로 복원할 수 있습니다.`,
                );
            });
            return;
        }
        if (this.selectionResize?.drag === drag) {
            drag.resizeReleased = true;
            this.sync(false);
            return;
        }
        let selectionPath: Point[] | undefined;
        const stroke = this.doc.stroke,
            revision = this.doc.revision;
        if (this.doc.stroke) this.doc.endStroke(drag.last.x, drag.last.y);
        else if (drag.mode === 'curve-control') {
            this.curveControls.push(drag.last);
            if (this.curveControls.length === 2) {
                try {
                    this.commitShape(this.points[0], this.points[1], 'curve');
                } catch (error) {
                    this.curveControls.pop();
                    throw error;
                }
                this.points = [];
                this.curveControls = [];
            }
        } else if (drag.mode === 'polygon-point') {
            const previous = this.points.at(-1);
            if (!previous || previous.x !== drag.last.x || previous.y !== drag.last.y)
                this.points.push(drag.last);
        } else if (['select', 'lasso'].includes(drag.mode)) {
            const s = this.doc.state,
                x = Math.max(0, Math.floor(Math.min(drag.start.x, drag.last.x))),
                y = Math.max(0, Math.floor(Math.min(drag.start.y, drag.last.y)));
            let w = Math.min(s.width, Math.ceil(Math.max(drag.start.x, drag.last.x))) - x,
                h = Math.min(s.height, Math.ceil(Math.max(drag.start.y, drag.last.y))) - y;
            if (drag.mode === 'lasso') {
                let left = Infinity,
                    top = Infinity,
                    right = -Infinity,
                    bottom = -Infinity;
                if (this.points.length >= 8192) selectionPath = this.points;
                else {
                    for (const point of this.points) {
                        left = Math.min(left, point.x);
                        top = Math.min(top, point.y);
                        right = Math.max(right, point.x);
                        bottom = Math.max(bottom, point.y);
                    }
                    left = Math.max(0, left);
                    top = Math.max(0, top);
                    w = Math.min(s.width, right) - left;
                    h = Math.min(s.height, bottom) - top;
                    if (w * h >= 262144) selectionPath = this.points;
                    else this.makeSelection(left, top, w, h, this.points);
                }
                this.points = [];
            } else if (w > 0 && h > 0) this.makeSelection(x, y, w, h);
        } else if (['line', 'rectangle', 'roundrect', 'ellipse'].includes(drag.mode))
            this.commitShape(drag.start, drag.last, drag.mode);
        else if (drag.mode === 'curve') {
            this.points = [drag.start, drag.last];
            this.curveControls = [];
            this.message('곡선 제어점을 두 번 눌러 확정하세요. Esc로 취소합니다.');
        }
        this.drag = undefined;
        this.sync();
        const change = this.doc.history[this.doc.cursor - 1];
        if (stroke) this.draw(false, this.doc.state.layers[stroke.layer].pixels, stroke.tiles.values());
        else if (change?.beforeId === revision && change.tiles && change.layer !== undefined)
            this.draw(false, this.doc.state.layers[change.layer].pixels, change.tiles);
        else this.draw();
        this.resizeView();
        if (selectionPath) {
            const path = selectionPath;
            void this.run(() => this.prepareSelection(path));
        }
    }
    cancelPointer(id?: number, keepPointers = false): void {
        if (id !== undefined) {
            this.pointers.delete(id);
            if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
            if (this.drag?.pointer !== id && !this.navigation) {
                if (this.densityPending && !this.pointers.size) this.resizeView();
                return;
            }
        } else if (!keepPointers) {
            const ids = [...this.pointers.keys()];
            this.pointers.clear();
            for (const pointer of ids)
                if (this.canvas.hasPointerCapture(pointer)) this.canvas.releasePointerCapture(pointer);
        }
        const resize = this.selectionResize;
        if (resize) {
            this.selectionResize = undefined;
            resize.cancel?.();
        }
        const preparation = this.selectionPreparation;
        if (preparation) {
            preparation.abort?.();
            if (this.selectionPreparation === preparation) this.selectionPreparation = undefined;
        }
        if (this.drag?.mode === 'lasso') this.points = [];
        const stroke = this.doc.stroke;
        this.doc.cancelStroke();
        this.stopSpray();
        if (this.selection && this.drag && ['move-selection', 'resize-selection'].includes(this.drag.mode)) {
            this.selection.x = this.drag.selectionX!;
            this.selection.y = this.drag.selectionY!;
            this.selection.modified = this.drag.selectionModified!;
            if (this.drag.selectionRaster) Object.assign(this.selection, this.drag.selectionRaster);
            this.selection.resizeSource = this.drag.selectionResizeSource;
        }
        if (this.drag?.previousShapeSecondary !== undefined)
            this.shapeSecondary = this.drag.previousShapeSecondary;
        this.drag = undefined;
        this.mouseButtonMask = 0;
        this.navigation = undefined;
        this.sync(false);
        if (stroke) this.draw(false, this.doc.state.layers[stroke.layer].pixels, stroke.tiles.values());
        else this.draw();
        const rect = this.workspace.getBoundingClientRect(),
            dpr = Math.min(devicePixelRatio || 1, 2);
        if (
            (this.densityPending && !this.pointers.size) ||
            rect.left !== this.viewLeft ||
            rect.top !== this.viewTop ||
            rect.width !== this.viewWidth ||
            rect.height !== this.viewHeight ||
            this.canvas.width !== Math.max(1, Math.round(rect.width * dpr)) ||
            this.canvas.height !== Math.max(1, Math.round(rect.height * dpr))
        )
            this.resizeView();
    }
    async resizeSelection(width: number, height: number): Promise<void> {
        const q = this.selection!,
            drag = this.drag!,
            state = this.doc.state,
            epoch = this.epoch,
            revision = this.doc.revision,
            active = state.active,
            documentPixels = state.layers[active].pixels,
            documentWidth = state.width,
            documentHeight = state.height,
            x = q.x,
            y = q.y,
            pixels = q.pixels,
            currentWidth = q.width,
            currentHeight = q.height,
            backing = q.resizeSource,
            mask = q.sourceMask,
            source = q.source,
            originalPixels = q.originalPixels,
            base = drag.selectionResizeSource || drag.selectionRaster!,
            baseWidth = base.width,
            baseHeight = base.height,
            basePixels = base.pixels,
            job = { drag, width, height, cancel: undefined as (() => void) | undefined };
        this.selectionResize = job;
        let channel: MessageChannel | undefined,
            timer: ReturnType<typeof setTimeout> | undefined,
            pending: (() => void) | undefined,
            cancelled = false,
            timedOut = false,
            steps: ReturnType<typeof resizeNearestSteps> | undefined;
        try {
            channel = new MessageChannel();
            channel.port1.onmessage = () => {
                const resolve = pending;
                pending = undefined;
                resolve?.();
            };
            job.cancel = () => {
                cancelled = true;
                const resolve = pending;
                pending = undefined;
                resolve?.();
            };
            timer = setTimeout(() => {
                timedOut = true;
                job.cancel?.();
            }, 20000);
            this.canvas.dataset.ready = 'false';
            this.canvas.setAttribute('aria-busy', 'true');
            this.message('선택 크기 계산 중… 취소 버튼이나 Esc로 취소할 수 있습니다.');
            this.sync(false);
            while (true) {
                await new Promise<void>((resolve) => {
                    pending = resolve;
                    channel!.port2.postMessage(0);
                });
                if (this.selectionResize !== job || (cancelled && !timedOut)) return;
                if (
                    this.drag !== drag ||
                    this.selection !== q ||
                    this.doc.state !== state ||
                    this.epoch !== epoch ||
                    this.doc.revision !== revision ||
                    state.active !== active ||
                    state.width !== documentWidth ||
                    state.height !== documentHeight ||
                    state.layers[active]?.pixels !== documentPixels ||
                    q.x !== x ||
                    q.y !== y ||
                    q.pixels !== pixels ||
                    q.width !== currentWidth ||
                    q.height !== currentHeight ||
                    q.resizeSource !== backing ||
                    q.sourceMask !== mask ||
                    q.source !== source ||
                    q.originalPixels !== originalPixels ||
                    base.width !== baseWidth ||
                    base.height !== baseHeight ||
                    base.pixels !== basePixels
                ) {
                    if (this.drag === drag) {
                        this.drag = undefined;
                        this.mouseButtonMask = 0;
                        this.pointers.delete(drag.pointer);
                        if (this.canvas.hasPointerCapture(drag.pointer))
                            this.canvas.releasePointerCapture(drag.pointer);
                    }
                    return;
                }
                if (timedOut) throw Error('크기 변경 시간이 초과됐습니다. 현재 그림은 유지됩니다.');
                if (!steps || width !== job.width || height !== job.height) {
                    steps?.return(state);
                    width = job.width;
                    height = job.height;
                    validateSize(width, height, 1, runtimeProfile);
                    validateSize(
                        Math.max(state.width, x + width),
                        Math.max(state.height, y + height),
                        state.layers.length,
                        runtimeProfile,
                    );
                    steps = resizeNearestSteps(
                        {
                            width: baseWidth,
                            height: baseHeight,
                            background: [0, 0, 0, 0],
                            active: 0,
                            layers: [{ name: 'selection', visible: true, pixels: basePixels }],
                        },
                        width,
                        height,
                        runtimeProfile,
                    );
                }
                const step = steps.next();
                if (step.done) {
                    q.width = width;
                    q.height = height;
                    q.pixels = step.value.layers[0].pixels;
                    q.resizeSource = base;
                    q.modified =
                        !q.source ||
                        q.x !== q.source.x ||
                        q.y !== q.source.y ||
                        q.width !== q.source.width ||
                        q.height !== q.source.height ||
                        q.pixels !== q.originalPixels;
                    if (drag.resizeReleased && this.drag === drag) this.drag = undefined;
                    this.message('선택 크기를 변경했습니다.');
                    return;
                }
            }
        } catch (error) {
            if (this.selectionResize === job) {
                this.selectionResize = undefined;
                if (
                    this.drag === drag &&
                    this.selection === q &&
                    this.doc.state === state &&
                    this.doc.revision === revision &&
                    this.epoch === epoch &&
                    state.active === active &&
                    state.width === documentWidth &&
                    state.height === documentHeight &&
                    state.layers[active]?.pixels === documentPixels &&
                    q.x === x &&
                    q.y === y &&
                    q.pixels === pixels &&
                    q.width === currentWidth &&
                    q.height === currentHeight &&
                    q.resizeSource === backing &&
                    q.sourceMask === mask &&
                    q.source === source &&
                    q.originalPixels === originalPixels &&
                    base.width === baseWidth &&
                    base.height === baseHeight &&
                    base.pixels === basePixels
                )
                    this.cancelPointer();
                else if (this.drag === drag) {
                    this.drag = undefined;
                    this.mouseButtonMask = 0;
                    this.pointers.delete(drag.pointer);
                    if (this.canvas.hasPointerCapture(drag.pointer))
                        this.canvas.releasePointerCapture(drag.pointer);
                }
                this.message(error instanceof Error ? error.message : String(error));
                this.sync(false);
                this.draw();
                this.resizeView();
            }
        } finally {
            clearTimeout(timer);
            steps?.return(state);
            pending = undefined;
            if (channel) {
                channel.port1.onmessage = null;
                channel.port1.close();
                channel.port2.close();
            }
            if (this.selectionResize === job) {
                this.selectionResize = undefined;
                this.sync(false);
                this.draw();
                this.resizeView();
            }
        }
    }
    stopSpray(): void {
        if (this.sprayTimer) clearInterval(this.sprayTimer);
        this.sprayTimer = undefined;
    }
    paintShape(
        ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
        a: Point,
        b: Point,
        tool: string,
    ): void {
        ctx.save();
        ctx.lineWidth = this.size;
        const stroke = this.shapeSecondary ? this.secondary : this.foreground,
            fill = this.shapeSecondary ? this.foreground : this.secondary;
        ctx.strokeStyle = `rgba(${stroke[0]},${stroke[1]},${stroke[2]},${stroke[3] / 255})`;
        ctx.fillStyle = `rgba(${fill[0]},${fill[1]},${fill[2]},${fill[3] / 255})`;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const x = Math.min(a.x, b.x),
            y = Math.min(a.y, b.y),
            w = Math.abs(b.x - a.x),
            h = Math.abs(b.y - a.y);
        if (tool === 'line') {
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
        } else if (tool === 'curve') {
            ctx.moveTo(a.x, a.y);
            const c = this.curveControls;
            ctx.bezierCurveTo(c[0]?.x ?? a.x, c[0]?.y ?? a.y, c[1]?.x ?? b.x, c[1]?.y ?? b.y, b.x, b.y);
        } else if (tool === 'ellipse')
            ctx.ellipse(
                x + w / 2,
                y + h / 2,
                Math.max(0.01, w / 2),
                Math.max(0.01, h / 2),
                0,
                0,
                Math.PI * 2,
            );
        else if (tool === 'roundrect')
            ctx.roundRect(
                x,
                y,
                w,
                h,
                w === 0 || h === 0 ? 0 : { x: Math.min(12, w / 2), y: Math.min(12, h / 2) },
            );
        else if (tool === 'polygon') {
            this.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.closePath();
        } else ctx.rect(x, y, w, h);
        if (this.fillShape && !['line', 'curve'].includes(tool)) ctx.fill();
        if (this.outlineShape || ['line', 'curve'].includes(tool)) ctx.stroke();
        ctx.restore();
    }
    shapeRaster(
        a: Point,
        b: Point,
        tool: string,
        state: State,
    ): (Raster & { left: number; top: number }) | undefined {
        const points =
            tool === 'polygon' ? this.points : tool === 'curve' ? [a, b, ...this.curveControls] : [a, b];
        let left = Infinity,
            top = Infinity,
            right = -Infinity,
            bottom = -Infinity;
        for (const point of points) {
            left = Math.min(left, point.x);
            top = Math.min(top, point.y);
            right = Math.max(right, point.x);
            bottom = Math.max(bottom, point.y);
        }
        const pad = this.size + 2;
        left = Math.max(0, Math.floor(left - pad));
        top = Math.max(0, Math.floor(top - pad));
        right = Math.min(state.width, Math.ceil(right + pad));
        bottom = Math.min(state.height, Math.ceil(bottom + pad));
        const width = right - left,
            height = bottom - top;
        if (width <= 0 || height <= 0) return;
        validateSize(width, height, 1, runtimeProfile);
        const pixels = new Uint8ClampedArray(width * height * 4),
            surface = createSurface(Math.min(512, width), Math.min(512, height));
        try {
            const ctx = context2D(surface);
            for (let y = 0; y < height; y += 512)
                for (let x = 0; x < width; x += 512) {
                    const w = Math.min(512, width - x),
                        h = Math.min(512, height - y);
                    surface.width = w;
                    surface.height = h;
                    ctx.setTransform(1, 0, 0, 1, -left - x, -top - y);
                    this.paintShape(ctx, a, b, tool);
                    const tile = ctx.getImageData(0, 0, w, h).data;
                    for (let row = 0; row < h; row++)
                        pixels.set(
                            tile.subarray(row * w * 4, (row + 1) * w * 4),
                            ((y + row) * width + x) * 4,
                        );
                }
        } finally {
            surface.width = 0;
            surface.height = 0;
        }
        return { left, top, width, height, pixels };
    }
    commitShape(a: Point, b: Point, tool: string): void {
        const s = this.doc.state,
            raster = this.shapeRaster(a, b, tool, s);
        if (raster)
            this.doc.replacePixels(
                '도형',
                s.active,
                raster.left,
                raster.top,
                raster.width,
                raster.height,
                raster.pixels,
                true,
            );
    }
    commitPolygon(): void {
        if (this.points.length >= 3) this.commitShape(this.points[0], this.points.at(-1)!, 'polygon');
        this.points = [];
        this.draw(true);
    }
    makeSelection(x: number, y: number, width: number, height: number, path?: Point[]): void {
        if (width < 1 || height < 1) return;
        const s = this.doc.state,
            pixels = new Uint8ClampedArray(width * height * 4),
            image = s.layers[s.active].pixels;
        for (let row = 0; row < height; row++)
            pixels.set(
                image.subarray(((y + row) * s.width + x) * 4, ((y + row) * s.width + x + width) * 4),
                row * width * 4,
            );
        const mask = applySelectionMask(
            pixels,
            width,
            height,
            x,
            y,
            path,
            this.secondary,
            this.transparentSelection,
            runtimeProfile,
        );
        this.selection = {
            x,
            y,
            width,
            height,
            pixels,
            source: { x, y, width, height },
            modified: false,
            sourceMask: mask,
            originalPixels: pixels,
        };
        this.sync(false);
    }
    async prepareSelection(path: Point[]): Promise<void> {
        const job: { abort?: () => void } = {};
        const state = this.doc.state,
            epoch = this.epoch,
            revision = this.doc.revision,
            active = state.active,
            image = state.layers[active].pixels,
            sourceWidth = state.width,
            sourceHeight = state.height,
            previousSelection = this.selection,
            key = [...this.secondary] as Color,
            transparent = this.transparentSelection,
            tool = this.tool;
        if (this.selectionPreparation) throw Error('선택 영역을 준비하고 있습니다.');
        this.selectionPreparation = job;
        try {
            await this.task('선택 영역 준비 중', async (signal) => {
                const controller = this.abort;
                job.abort = () => controller?.abort();
                const channel = new MessageChannel();
                let pending: { resolve: () => void; reject: (reason: unknown) => void } | undefined;
                const abort = () => {
                    const waiter = pending;
                    pending = undefined;
                    waiter?.reject(Error('작업을 취소했습니다.'));
                };
                // One channel owns the cooperative waits, including their abort settlement.
                const yieldTask = async () => {
                    signal.throwIfAborted();
                    await new Promise<void>((resolve, reject) => {
                        pending = { resolve, reject };
                        channel.port2.postMessage(0);
                    });
                    signal.throwIfAborted();
                };
                try {
                    channel.port1.onmessage = () => {
                        const waiter = pending;
                        pending = undefined;
                        waiter?.resolve();
                    };
                    signal.addEventListener('abort', abort);
                    await yieldTask();
                    const points = new Float64Array(path.length * 2);
                    let left = Infinity,
                        top = Infinity,
                        right = -Infinity,
                        bottom = -Infinity;
                    for (let start = 0; start < path.length; start += 4096) {
                        for (let i = start; i < Math.min(path.length, start + 4096); i++) {
                            const point = path[i];
                            points[i * 2] = point.x;
                            points[i * 2 + 1] = point.y;
                            left = Math.min(left, point.x);
                            top = Math.min(top, point.y);
                            right = Math.max(right, point.x);
                            bottom = Math.max(bottom, point.y);
                        }
                        await yieldTask();
                    }
                    path = [];
                    left = Math.max(0, left);
                    top = Math.max(0, top);
                    const width = Math.min(sourceWidth, right) - left,
                        height = Math.min(sourceHeight, bottom) - top;
                    if (width < 1 || height < 1) return;
                    validateSize(width, height, 1, runtimeProfile);
                    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(top))
                        throw Error('선택 영역 좌표가 올바르지 않습니다.');
                    const pixels = new Uint8ClampedArray(width * height * 4),
                        rows = Math.max(1, Math.floor(65536 / width));
                    for (let start = 0; start < height; start += rows) {
                        for (let row = start; row < Math.min(height, start + rows); row++)
                            pixels.set(
                                image.subarray(
                                    ((top + row) * sourceWidth + left) * 4,
                                    ((top + row) * sourceWidth + left + width) * 4,
                                ),
                                row * width * 4,
                            );
                        await yieldTask();
                    }
                    const candidate: State = {
                        width,
                        height,
                        background: [0, 0, 0, 0],
                        active: 0,
                        layers: [{ name: 'selection', visible: true, pixels }],
                    };
                    // Only the owned crop and packed path are detached; the live layer stays attached.
                    const result = await runCodec('selection', candidate, undefined, signal, runtimeProfile, {
                        points,
                        left,
                        top,
                        key,
                        transparent,
                    });
                    const raster = result.image,
                        mask = result.bytes;
                    if (
                        !raster ||
                        raster.width !== width ||
                        raster.height !== height ||
                        !mask ||
                        mask.length !== width * height
                    )
                        throw Error('선택 영역 결과 크기가 올바르지 않습니다.');
                    for (let start = 0; start < mask.length; start += 65536) {
                        for (let i = start; i < Math.min(mask.length, start + 65536); i++)
                            if (mask[i] !== 0 && mask[i] !== 255)
                                throw Error('선택 영역 마스크가 올바르지 않습니다.');
                        await yieldTask();
                    }
                    signal.throwIfAborted();
                    if (
                        this.selectionPreparation !== job ||
                        this.doc.state !== state ||
                        this.epoch !== epoch ||
                        this.doc.revision !== revision ||
                        state.active !== active ||
                        state.width !== sourceWidth ||
                        state.height !== sourceHeight ||
                        state.layers[active]?.pixels !== image ||
                        this.selection !== previousSelection ||
                        this.tool !== tool ||
                        this.drag ||
                        this.transparentSelection !== transparent ||
                        this.secondary.length !== key.length ||
                        this.secondary.some((value, index) => value !== key[index])
                    )
                        return;
                    this.selection = {
                        x: left,
                        y: top,
                        width,
                        height,
                        pixels: raster.pixels,
                        source: { x: left, y: top, width, height },
                        modified: false,
                        sourceMask: mask,
                        originalPixels: raster.pixels,
                    };
                } finally {
                    signal.removeEventListener('abort', abort);
                    pending = undefined;
                    channel.port1.onmessage = null;
                    channel.port1.close();
                    channel.port2.close();
                }
            });
        } finally {
            if (this.selectionPreparation === job) this.selectionPreparation = undefined;
        }
    }
    clearSelectionSource(state: State, selection: Selection): void {
        const source = selection.source;
        if (!source) return;
        const pixels = state.layers[state.active].pixels,
            mask = selection.sourceMask,
            [red, green, blue, alpha] = state.layers.length === 1 ? state.background : [0, 0, 0, 0];
        for (let y = 0; y < source.height; y++) {
            const row = ((source.y + y) * state.width + source.x) * 4,
                maskRow = y * source.width;
            for (let x = 0; x < source.width; x++) {
                if (mask && !mask[maskRow + x]) continue;
                const i = row + x * 4;
                pixels[i] = red;
                pixels[i + 1] = green;
                pixels[i + 2] = blue;
                pixels[i + 3] = alpha;
            }
        }
    }
    editPending(label: string, work: (state: State) => State | void): void {
        const candidate = this.pendingState(),
            result = work(candidate) || candidate;
        this.commitPending(label, result);
    }
    commitPending(label: string, result: State): void {
        this.doc.commitState(label, result);
        this.selection = undefined;
        this.selectionCache = undefined;
        this.editor?.remove();
        this.editor = undefined;
        this.textPoint = undefined;
        this.points = [];
        this.curveControls = [];
        this.draw(true);
    }
    async editDocument(
        label: string,
        options: Parameters<typeof runGeometry>[1] | { kind: 'clear' | 'invert' | 'merge' },
        fit = true,
    ): Promise<void> {
        const state = this.doc.state,
            revision = this.doc.revision,
            epoch = this.epoch,
            active = state.active,
            candidate = this.pendingState();
        await this.task(label, async (signal) => {
            const layerEdit =
                options.kind === 'clear' || options.kind === 'invert' || options.kind === 'merge';
            const result = layerEdit
                ? (
                      await runCodec(
                          'layer-edit',
                          candidate,
                          new TextEncoder().encode(options.kind),
                          signal,
                          runtimeProfile,
                      )
                  ).state!
                : await runGeometry(
                      candidate,
                      options as Parameters<typeof runGeometry>[1],
                      signal,
                      runtimeProfile,
                  );
            if (
                signal.aborted ||
                state !== this.doc.state ||
                revision !== this.doc.revision ||
                epoch !== this.epoch ||
                active !== state.active
            )
                throw Error('편집 상태가 변경되어 변형을 적용하지 않았습니다.');
            this.commitPending(label, result);
            if (!layerEdit && fit) this.fit();
        });
    }
    async transformSelection(change: Parameters<typeof runGeometry>[1]): Promise<void> {
        const selection = this.selection;
        if (!selection) throw Error('먼저 영역을 선택하세요.');
        const state = this.doc.state,
            active = state.active,
            revision = this.doc.revision,
            epoch = this.epoch,
            pixels = selection.pixels,
            width = selection.width,
            height = selection.height,
            resizeSource = selection.resizeSource,
            resizing = change.kind === 'resize' && change.scale === true && change.smooth !== true,
            input = resizing && resizeSource ? resizeSource : { width, height, pixels };
        await this.task('선택 변형 중', async (signal) => {
            const transformed = await runGeometry(
                {
                    width: input.width,
                    height: input.height,
                    background: [0, 0, 0, 0],
                    active: 0,
                    layers: [{ name: '선택', visible: true, pixels: input.pixels.slice() }],
                },
                change,
                signal,
                runtimeProfile,
            );
            if (
                signal.aborted ||
                this.selection !== selection ||
                this.doc.state !== state ||
                state.active !== active ||
                this.doc.revision !== revision ||
                this.epoch !== epoch ||
                selection.pixels !== pixels ||
                selection.width !== width ||
                selection.height !== height ||
                selection.resizeSource !== resizeSource
            )
                throw Error('선택 상태가 변경되어 변형을 적용하지 않았습니다.');
            validateSize(
                Math.max(state.width, selection.x + transformed.width),
                Math.max(state.height, selection.y + transformed.height),
                state.layers.length,
                runtimeProfile,
            );
            selection.width = transformed.width;
            selection.height = transformed.height;
            selection.pixels =
                resizing && transformed.width === input.width && transformed.height === input.height
                    ? input.pixels
                    : transformed.layers[0].pixels;
            selection.resizeSource = resizing ? input : undefined;
            selection.modified = true;
            selection.originalPixels = undefined;
            this.draw();
        });
    }
    pendingState(includeSelection = true): State {
        if (this.selectionResize) throw Error('선택 크기 변경을 마치거나 취소한 뒤 실행하세요.');
        if (this.composing) throw Error('문자 조합을 먼저 확정하세요.');
        if (this.doc.stroke) throw Error('현재 그리기를 마친 뒤 실행하세요.');
        let state = cloneState(this.doc.state);
        const q = this.selection;
        if ((q && q.modified) || (q && !includeSelection)) {
            this.clearSelectionSource(state, q);
            if (includeSelection) state.layers[state.active].visible = true;
            if (includeSelection) {
                const width = Math.max(state.width, q.x + q.width),
                    height = Math.max(state.height, q.y + q.height);
                if (width !== state.width || height !== state.height)
                    state = resizeState(state, width, height, false, false, runtimeProfile);
                const image = state.layers[state.active].pixels;
                for (let y = 0; y < q.height; y++)
                    for (let x = 0; x < q.width; x++) {
                        const tx = x + q.x,
                            ty = y + q.y;
                        if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
                        const i = (ty * state.width + tx) * 4,
                            j = (y * q.width + x) * 4,
                            a = q.pixels[j + 3] / 255;
                        if (!a) continue;
                        const b = image[i + 3] / 255,
                            oa = a + b * (1 - a);
                        for (let c = 0; c < 3; c++)
                            image[i + c] = oa
                                ? Math.round((q.pixels[j + c] * a + image[i + c] * b * (1 - a)) / oa)
                                : 0;
                        image[i + 3] = Math.round(oa * 255);
                    }
            }
        }
        if (this.editor?.value && this.textPoint) {
            state.layers[state.active].visible = true;
            const raster = this.textRaster(),
                p = this.textPoint;
            const image = state.layers[state.active].pixels;
            for (let y = 0; y < raster.height; y++)
                for (let x = 0; x < raster.width; x++) {
                    const tx = x + Math.floor(p.x),
                        ty = y + Math.floor(p.y);
                    if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
                    const i = (ty * state.width + tx) * 4,
                        j = (y * raster.width + x) * 4,
                        a = raster.pixels[j + 3] / 255;
                    if (!a) continue;
                    const b = image[i + 3] / 255,
                        oa = a + b * (1 - a);
                    for (let c = 0; c < 3; c++)
                        image[i + c] = oa
                            ? Math.round((raster.pixels[j + c] * a + image[i + c] * b * (1 - a)) / oa)
                            : 0;
                    image[i + 3] = Math.round(oa * 255);
                }
        }
        if (
            (this.tool === 'curve' && this.points.length === 2) ||
            (this.tool === 'polygon' && this.points.length >= 3)
        ) {
            const raster = this.shapeRaster(this.points[0], this.points.at(-1)!, this.tool, state),
                image = state.layers[state.active].pixels;
            if (raster)
                for (let y = 0; y < raster.height; y++)
                    for (let x = 0; x < raster.width; x++) {
                        const j = (y * raster.width + x) * 4,
                            a = raster.pixels[j + 3] / 255;
                        if (!a) continue;
                        const i = ((raster.top + y) * state.width + raster.left + x) * 4,
                            b = image[i + 3] / 255,
                            oa = a + b * (1 - a);
                        for (let c = 0; c < 3; c++)
                            image[i + c] = Math.round(
                                (raster.pixels[j + c] * a + image[i + c] * b * (1 - a)) / oa,
                            );
                        image[i + 3] = Math.round(oa * 255);
                    }
            state.layers[state.active].visible = true;
        }
        return state;
    }
    settle(): void {
        if (!this.hasPending()) return;
        if (
            this.selection &&
            !this.selection.modified &&
            !this.editor &&
            !this.points.length &&
            !this.curveControls.length &&
            !this.selectionResize &&
            !this.selectionPreparation &&
            !this.composing &&
            !this.doc.stroke
        ) {
            this.commitPending('선택 / 붙여넣기', this.doc.state);
            return;
        }
        this.editPending(this.editor ? '문자' : this.points.length ? '도형' : '선택 / 붙여넣기', () => {});
    }
    chooseTool(tool: Tool): void {
        if (this.busy || this.drag || this.doc.stroke) throw Error('현재 조작을 마친 뒤 도구를 선택하세요.');
        this.settle();
        this.tool = tool;
        this.canvas.focus();
        this.sync();
        this.draw();
    }
    beginText(p: Point): void {
        const editor = document.createElement('textarea');
        editor.className = 'text-editor';
        editor.setAttribute('aria-label', '문자 입력. Ctrl 또는 Command와 Enter로 확정, Escape로 취소');
        editor.maxLength = 65536;
        editor.spellcheck = false;
        this.editor = editor;
        this.textPoint = p;
        this.workspace.append(editor);
        this.placeEditor();
        editor.addEventListener('compositionstart', () => {
            this.composing = true;
        });
        editor.addEventListener('compositionend', () => {
            this.composing = false;
        });
        editor.oninput = () => this.sync(false);
        editor.focus();
    }
    placeEditor(): void {
        if (!this.editor || !this.textPoint) return;
        const style = this.editor.style;
        if (!style.width) style.width = '260px';
        if (!style.height) style.height = '120px';
        Object.assign(style, {
            left: this.offsetX + this.textPoint.x * this.zoom + 'px',
            top: this.offsetY + this.textPoint.y * this.zoom + 'px',
            transform: `scale(${this.zoom})`,
            transformOrigin: 'top left',
            fontSize: this.fontSize + 'px',
            fontFamily: this.fontFamily,
            fontWeight: this.fontBold ? 'bold' : 'normal',
            fontStyle: this.fontItalic ? 'italic' : 'normal',
            color: `rgba(${this.foreground[0]},${this.foreground[1]},${this.foreground[2]},${this.foreground[3] / 255})`,
            background: this.textBackground
                ? `rgba(${this.secondary[0]},${this.secondary[1]},${this.secondary[2]},${this.secondary[3] / 255})`
                : 'transparent',
        });
    }
    *textLayoutSteps(): Generator<void, TextLayout> {
        const editor = this.editor!,
            width = Math.max(1, Math.round(editor.clientWidth)),
            height = Math.max(1, Math.round(editor.clientHeight)),
            value = editor.value,
            fontSize = this.fontSize,
            font = `${this.fontItalic ? 'italic ' : ''}${this.fontBold ? 'bold ' : ''}${fontSize}px ${this.fontFamily}`,
            foreground = `rgba(${this.foreground[0]},${this.foreground[1]},${this.foreground[2]},${this.foreground[3] / 255})`,
            background = this.textBackground
                ? `rgba(${this.secondary[0]},${this.secondary[1]},${this.secondary[2]},${this.secondary[3] / 255})`
                : undefined;
        validateSize(width, height, 1, runtimeProfile);
        const surface = createSurface(1, 1);
        try {
            const ctx = context2D(surface),
                lines: TextLayout['lines'] = [];
            ctx.font = font;
            let line = '',
                y = 4 - editor.scrollTop,
                count = 0;
            for (const ch of value) {
                if (ch === '\n' || ctx.measureText(line + ch).width > width - 8) {
                    lines.push({ text: line, y });
                    y += fontSize * 1.3;
                    line = '';
                    if (ch !== '\n') line = ch;
                } else line += ch;
                if (++count % 256 === 0) yield;
            }
            lines.push({ text: line, y });
            return { width, height, font, fontSize, lines, foreground, background };
        } finally {
            surface.width = 0;
            surface.height = 0;
        }
    }
    paintText(
        ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
        layout: TextLayout,
        top = 0,
        height = layout.height,
    ): void {
        ctx.save();
        try {
            ctx.beginPath();
            ctx.rect(0, 0, layout.width, layout.height);
            ctx.clip();
            if (layout.background) {
                ctx.fillStyle = layout.background;
                ctx.fillRect(0, 0, layout.width, layout.height);
            }
            ctx.font = layout.font;
            ctx.textBaseline = 'top';
            ctx.fillStyle = layout.foreground;
            for (const entry of layout.lines)
                if (entry.y + layout.fontSize * 2 >= top && entry.y <= top + height)
                    ctx.fillText(entry.text, 4, entry.y);
        } finally {
            ctx.restore();
        }
    }
    textRaster(): Raster {
        const steps = this.textLayoutSteps();
        let step = steps.next();
        while (!step.done) step = steps.next();
        const layout = step.value,
            { width, height } = layout,
            surface = createSurface(Math.min(512, width), Math.min(512, height));
        try {
            const ctx = context2D(surface),
                pixels = new Uint8ClampedArray(width * height * 4);
            for (let ty = 0; ty < height; ty += 512)
                for (let tx = 0; tx < width; tx += 512) {
                    const w = Math.min(512, width - tx),
                        h = Math.min(512, height - ty);
                    surface.width = w;
                    surface.height = h;
                    ctx.setTransform(1, 0, 0, 1, -tx, -ty);
                    this.paintText(ctx, layout, ty, h);
                    const tile = ctx.getImageData(0, 0, w, h).data;
                    for (let row = 0; row < h; row++)
                        pixels.set(
                            tile.subarray(row * w * 4, (row + 1) * w * 4),
                            ((ty + row) * width + tx) * 4,
                        );
                }
            return { width, height, pixels };
        } finally {
            surface.width = 0;
            surface.height = 0;
        }
    }
    async dialog(
        title: string,
        fields: Field[],
        ok = '확인',
        notice = '',
        content?: HTMLElement,
    ): Promise<Record<string, string> | undefined> {
        const previous = document.activeElement as HTMLElement | null,
            dialog = document.createElement('dialog'),
            form = document.createElement('form'),
            heading = document.createElement('h2');
        heading.textContent = title;
        form.method = 'dialog';
        form.append(heading);
        if (notice) {
            const message = document.createElement('p');
            message.textContent = notice;
            form.append(message);
        }
        for (const f of fields) {
            const label = document.createElement('label');
            label.append(document.createTextNode(f.label));
            let input: HTMLInputElement | HTMLSelectElement;
            if (f.options) {
                input = document.createElement('select');
                for (const value of f.options) {
                    const option = document.createElement('option');
                    option.value = option.textContent = value;
                    input.append(option);
                }
            } else {
                input = document.createElement('input');
                input.type = f.type || 'text';
                if (f.min !== undefined) input.min = String(f.min);
                if (f.max !== undefined) input.max = String(f.max);
                input.required = true;
                input.maxLength = f.key === 'name' ? 256 : 65536;
            }
            input.name = f.key;
            input.setAttribute('aria-label', f.label);
            input.value = f.value ?? '';
            label.append(input);
            form.append(label);
        }
        const footer = document.createElement('footer'),
            cancel = document.createElement('button'),
            confirm = document.createElement('button');
        cancel.textContent = '취소';
        cancel.value = 'cancel';
        cancel.formNoValidate = true;
        confirm.textContent = ok;
        confirm.value = 'ok';
        confirm.className = 'primary';
        footer.append(cancel, confirm);
        if (content) form.append(content);
        form.append(footer);
        dialog.append(form);
        document.body.append(dialog);
        try {
            dialog.showModal();
        } catch (error) {
            dialog.remove();
            if (previous?.isConnected) previous.focus();
            throw error;
        }
        return await new Promise((resolve) => {
            dialog.onclose = () => {
                const values = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
                const accepted = dialog.returnValue === 'ok';
                dialog.remove();
                if (previous?.isConnected) previous.focus();
                resolve(accepted ? values : undefined);
            };
        });
    }
    async menu(kind = 'menu'): Promise<void> {
        const dialog = document.createElement('dialog'),
            title = document.createElement('h2');
        title.textContent = kind === 'tools' ? '그리기 도구' : '파일 · 편집 · 이미지';
        dialog.append(title);
        const grid = document.createElement('div');
        grid.className = 'menu-grid';
        let selected: string | undefined;
        const commands =
            kind === 'tools'
                ? toolDefinitions.map((t) => [t[0], t[1], t[0]])
                : [
                      ['new', '새 그림', 'plus'],
                      ['open', '파일 열기', 'open'],
                      ['insert', '사진 삽입', 'open'],
                      ['save', '프로젝트 저장', 'save'],
                      ['save-as', '프로젝트 다른 이름 저장', 'save'],
                      ['export', '이미지 내보내기', 'export'],
                      ['recover', '복구 사본', 'save'],
                      ['copy', '복사', 'select'],
                      ['cut', '잘라내기', 'select'],
                      ['paste', '붙여넣기', 'select'],
                      ['select-all', '전체 선택', 'select'],
                      ['delete', '선택 삭제', 'eraser'],
                      ['crop', '선택 자르기', 'select'],
                      ['selection-size', '선택 크기', 'fit'],
                      ['canvas-size', '캔버스 크기', 'rectangle'],
                      ['image-size', '이미지 크기', 'fit'],
                      ['rotate-right', '오른쪽 회전', 'redo'],
                      ['rotate-left', '왼쪽 회전', 'undo'],
                      ['flip-x', '좌우 반전', 'pan'],
                      ['flip-y', '상하 반전', 'pan'],
                      ['shear', '가로 기울이기', 'polygon'],
                      ['invert', '색 반전', 'palette'],
                      ['clear', '활성 레이어 지우기', 'eraser'],
                      ['background', '문서 지우기 바탕', 'palette'],
                      ['text-options', '문자 설정', 'text'],
                      ['settings', '테마 · 환경설정', 'settings'],
                      ['help', '사용 방법', 'menu'],
                  ];
        for (const [command, label, image] of commands) {
            const button = document.createElement('button');
            button.disabled = ['crop', 'selection-size'].includes(command) && !this.selection;
            button.innerHTML = icon(image);
            button.append(document.createTextNode(label));
            button.onclick = () => {
                selected = command;
                dialog.close();
            };
            grid.append(button);
        }
        const close = document.createElement('button');
        close.textContent = '닫기';
        close.onclick = () => dialog.close();
        dialog.append(grid, close);
        document.body.append(dialog);
        dialog.showModal();
        await new Promise<void>((resolve) => {
            dialog.onclose = () => {
                dialog.remove();
                resolve();
            };
        });
        if (selected) {
            if (kind === 'tools') this.chooseTool(selected as Tool);
            else await this.command(selected);
        }
    }
    async replacementAllowed(): Promise<boolean> {
        if (!this.doc.dirty && !this.hasPending()) return true;
        const previous = document.activeElement as HTMLElement | null,
            dialog = document.createElement('dialog'),
            heading = document.createElement('h2'),
            message = document.createElement('p'),
            footer = document.createElement('footer');
        footer.className = 'unsaved-actions';
        heading.id = 'unsaved-heading';
        heading.textContent = '변경한 내용을 저장하시겠습니까?';
        dialog.setAttribute('aria-labelledby', heading.id);
        message.textContent = isDesktop()
            ? '저장하지 않고 버리면 현재 그림의 변경 사항을 잃습니다.'
            : '프로젝트를 다운로드하면 현재 그림은 유지됩니다. 파일을 확인한 뒤 계속하세요.';
        for (const [value, label] of [
            ['save', isDesktop() ? '저장' : '프로젝트 다운로드'],
            ['discard', '저장하지 않고 버리기'],
            ['cancel', '취소'],
        ]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.dataset.action = value;
            button.value = value;
            if (value === 'save') {
                button.className = 'primary';
                button.autofocus = true;
            }
            if (value === 'discard') button.className = 'destructive';
            button.onclick = () => dialog.close(value);
            footer.append(button);
        }
        dialog.append(heading, message, footer);
        document.body.append(dialog);
        let choice: string;
        try {
            choice = await new Promise<string>((resolve) => {
                dialog.onclose = () => resolve(dialog.returnValue);
                dialog.showModal();
            });
        } finally {
            dialog.remove();
            if (previous?.isConnected) previous.focus();
        }
        if (choice === 'save') {
            await this.saveProject();
            return isDesktop() && !this.doc.dirty && !this.hasPending();
        }
        return choice === 'discard';
    }
    async task(label: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
        if (this.busy) throw Error('진행 중인 작업을 먼저 마치세요.');
        const controller = new AbortController(),
            editor = this.editor;
        const controls = [...this.root.querySelectorAll<HTMLElement>('.topbar, .tools, .inspector')].map(
            (element) => ({ element, inert: element.inert }),
        );
        const overlay = document.createElement('div');
        overlay.className = 'busy';
        const text = document.createElement('span');
        text.textContent = label + ' · 현재 그림은 보존됩니다';
        const cancel = document.createElement('button');
        cancel.textContent = '취소';
        cancel.onclick = () => controller.abort();
        overlay.append(text, cancel);
        this.busy = true;
        this.abort = controller;
        try {
            for (const control of controls) control.element.inert = true;
            if (editor) editor.readOnly = true;
            this.workspace.append(overlay);
            await work(controller.signal);
        } finally {
            overlay.remove();
            if (editor) editor.readOnly = false;
            for (const control of controls) control.element.inert = control.inert;
            this.busy = false;
            this.abort = undefined;
        }
    }
    async replaceDocument(state: State, name: string, saved = true, sourceToken?: string): Promise<void> {
        validate(state, runtimeProfile);
        const generation = this.epoch + 1,
            key = crypto.randomUUID();
        await this.task('문서 준비 중', async (signal) => {
            signal.throwIfAborted();
            await activateNative(generation, key, sourceToken);
            // Activation is the commit point; a late cancel cannot split native and UI ownership.
            this.doc.reset(state, saved);
            this.recovery.reset(key, generation);
            this.epoch = generation;
            this.nativeReady = Promise.resolve();
            this.recoveredRevision = 0;
            this.name = name;
            this.selection = undefined;
            this.editor?.remove();
            this.editor = undefined;
            this.points = [];
            this.curveControls = [];
            this.cancelRenderPreparation();
            this.sceneCache.clear();
            this.fit();
            this.draw(true);
        });
    }
    async loadFile(
        file: Pick<File, 'name' | 'size' | 'arrayBuffer'>,
        insert = false,
        sourceToken?: string,
    ): Promise<void> {
        await this.nativeReady;
        if (this.drag || this.doc.stroke) throw Error('현재 조작을 마치세요.');
        const owner = this.doc.state,
            revision = this.doc.revision,
            epoch = this.epoch;
        let loaded: State | undefined;
        await this.task('파일 읽는 중', async (signal) => {
            loaded = await readArtwork(file, signal, runtimeProfile);
            if (signal.aborted) throw Error('작업을 취소했습니다.');
        });
        if (!loaded) return;
        if (insert) {
            if (this.doc.state !== owner || this.doc.revision !== revision || this.epoch !== epoch)
                throw Error('편집 상태가 변경되어 이미지를 삽입하지 않았습니다.');
            let x = 0,
                y = 0;
            if (
                this.offsetX < 0 ||
                this.offsetY < 0 ||
                this.offsetX >= this.viewWidth ||
                this.offsetY >= this.viewHeight
            ) {
                x = Math.max(
                    0,
                    Math.min(
                        runtimeProfile.dimension - loaded.width,
                        Math.round((this.viewWidth / 2 - this.offsetX) / this.zoom - loaded.width / 2),
                    ),
                );
                y = Math.max(
                    0,
                    Math.min(
                        runtimeProfile.dimension - loaded.height,
                        Math.round((this.viewHeight / 2 - this.offsetY) / this.zoom - loaded.height / 2),
                    ),
                );
            }
            try {
                validateSize(
                    Math.max(owner.width, x + loaded.width),
                    Math.max(owner.height, y + loaded.height),
                    owner.layers.length,
                    runtimeProfile,
                );
            } catch {
                x = y = 0;
                validateSize(
                    Math.max(owner.width, loaded.width),
                    Math.max(owner.height, loaded.height),
                    owner.layers.length,
                    runtimeProfile,
                );
            }
            const pixels = composite(loaded, runtimeProfile);
            this.settle();
            this.selection = { width: loaded.width, height: loaded.height, pixels, x, y, modified: true };
            this.tool = 'select';
            this.message('드래그로 배치 · Enter 확정 · Escape 취소');
        } else if (await this.replacementAllowed()) {
            await this.replaceDocument(loaded, file.name, true, sourceToken);
        }
        this.draw(true);
    }
    async openFile(insert = false): Promise<void> {
        await this.nativeReady;
        if (isDesktop()) {
            let selected: Awaited<ReturnType<typeof openNative>>;
            await this.task('파일 선택 및 읽는 중', async (signal) => {
                selected = await openNative(signal);
            });
            if (selected) {
                const file = selected;
                await this.loadFile(
                    {
                        name: file.name,
                        size: file.bytes.byteLength,
                        arrayBuffer: async () => file.bytes.buffer as ArrayBuffer,
                    },
                    insert,
                    !insert && file.isProject ? file.token : undefined,
                );
            }
            return;
        }
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.rpaint,.png,.jpg,.jpeg,.bmp,.gif';
        input.hidden = true;
        document.body.append(input);
        try {
            const file = await new Promise<File | undefined>((resolve) => {
                input.onchange = () => resolve(input.files?.[0]);
                input.oncancel = () => resolve(undefined);
                input.click();
            });
            if (file) await this.loadFile(file, insert);
        } finally {
            input.remove();
        }
    }
    showDownload(bytes: Uint8Array, name: string, mime: string): void {
        const next = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
        this.workspace.querySelector('.download')?.remove();
        if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
        this.downloadUrl = next;
        const panel = document.createElement('div');
        panel.className = 'download';
        panel.setAttribute('role', 'status');
        const text = document.createElement('span');
        text.textContent = name + ' 준비됨';
        const anchor = document.createElement('button');
        anchor.className = 'primary';
        anchor.textContent = '파일 받기';
        anchor.onclick = () => {
            const a = document.createElement('a');
            a.href = next;
            a.download = name;
            document.body.append(a);
            a.click();
            a.remove();
            text.textContent = '다운로드 요청됨. 실제 파일을 확인하세요.';
        };
        const close = document.createElement('button');
        close.setAttribute('aria-label', '다운로드 닫기');
        close.innerHTML = icon('close');
        close.onclick = () => {
            if (this.downloadUrl === next) {
                URL.revokeObjectURL(next);
                this.downloadUrl = undefined;
            }
            panel.remove();
        };
        panel.append(text, anchor, close);
        this.workspace.append(panel);
        this.message('파일 받기를 누르고 다운로드한 파일을 확인하세요.');
    }
    async saveProject(saveAs = false): Promise<void> {
        await this.nativeReady;
        let suggestedName = this.name.replace(/\.[^.]+$/, '') + '.rpaint';
        if (saveAs && !isDesktop()) {
            const result = await this.dialog('프로젝트 다른 이름 저장', [
                { key: 'name', label: '파일 이름', value: suggestedName },
            ]);
            if (!result) return;
            suggestedName = result.name.replace(/[\\/\0]/g, '_');
            if (!/\.rpaint$/i.test(suggestedName)) suggestedName += '.rpaint';
        }
        if (this.doc.stroke) throw Error('현재 획을 마친 뒤 저장하세요.');
        const state = this.doc.state,
            active = state.active;
        const candidate = this.pendingState(),
            revision = this.doc.revision,
            epoch = this.epoch,
            prepared = this.hasPending() ? this.doc.prepareState('저장', candidate) : undefined;
        await this.task('프로젝트 준비 중', async (signal) => {
            const bytes = await exportBytes(candidate, 'rpaint', undefined, signal, runtimeProfile);
            if (signal.aborted || revision !== this.doc.revision || epoch !== this.epoch)
                throw Error('문서가 변경됐습니다. 다시 저장하세요.');
            const name = suggestedName;
            if (isDesktop()) {
                const saved = await saveNative(bytes, name, signal, {
                    generation: epoch,
                    project: true,
                    saveAs,
                });
                if (saved) {
                    if (
                        this.doc.state !== state ||
                        this.doc.revision !== revision ||
                        this.epoch !== epoch ||
                        state.active !== active
                    ) {
                        this.message(
                            '파일은 저장됐습니다. 이후 변경된 현재 편집은 유지합니다. 다시 저장하세요.',
                        );
                        return;
                    }
                    if (prepared) this.doc.installPrepared(prepared);
                    this.selection = undefined;
                    this.editor?.remove();
                    this.editor = undefined;
                    this.points = [];
                    this.curveControls = [];
                    this.doc.markSaved(this.doc.revision);
                    this.name = saved;
                    this.message('프로젝트를 저장했습니다.');
                }
            } else this.showDownload(bytes, name, 'application/octet-stream');
        });
    }
    async exportImage(): Promise<void> {
        const doc = this.doc,
            state = doc.state,
            revision = doc.revision,
            epoch = this.epoch,
            selection = this.selection,
            editor = this.editor,
            active = state.active,
            points = this.points,
            curveControls = this.curveControls,
            pointSignature = JSON.stringify([points, curveControls]),
            signature = () =>
                JSON.stringify([
                    selection && [
                        selection.x,
                        selection.y,
                        selection.width,
                        selection.height,
                        selection.modified,
                        selection.source,
                    ],
                    editor && [editor.value, editor.clientWidth, editor.clientHeight, editor.scrollTop],
                    this.textPoint,
                    this.points.length,
                    this.points[0],
                    this.points.at(-1),
                    this.curveControls,
                    this.tool,
                    this.fontSize,
                    this.fontFamily,
                    this.fontBold,
                    this.fontItalic,
                    this.textBackground,
                    this.foreground,
                    this.secondary,
                    this.size,
                    this.fillShape,
                    this.outlineShape,
                    this.shapeSecondary,
                    this.composing,
                ]),
            initialSignature = signature(),
            selectionPixels = selection?.pixels,
            selectionMask = selection?.sourceMask,
            current = () =>
                this.doc === doc &&
                doc.state === state &&
                state.active === active &&
                doc.revision === revision &&
                this.epoch === epoch &&
                this.selection === selection &&
                this.editor === editor &&
                this.points === points &&
                this.curveControls === curveControls &&
                selection?.pixels === selectionPixels &&
                selection?.sourceMask === selectionMask &&
                !this.selectionResize &&
                !this.selectionPreparation &&
                !doc.stroke &&
                signature() === initialSignature,
            panel = document.createElement('section'),
            canvas = document.createElement('canvas'),
            status = document.createElement('p'),
            channel = new MessageChannel();
        let closed = false,
            resume: (() => void) | undefined,
            build: Promise<void> = Promise.resolve();
        const checkpoint = async () => {
            await new Promise<void>((resolve) => {
                resume = resolve;
                channel.port2.postMessage(null);
            });
            if (closed) throw Error('취소했습니다.');
            if (!current()) throw Error('그림이 변경되었습니다. 내보내기를 다시 실행하세요.');
        };
        try {
            panel.className = 'export-preview';
            panel.dataset.state = 'loading';
            canvas.setAttribute('aria-label', '내보낼 이미지 축소 미리보기');
            canvas.setAttribute('role', 'img');
            canvas.width = canvas.height = 1;
            status.setAttribute('role', 'status');
            status.textContent = '미리보기를 준비하고 있습니다…';
            panel.append(canvas, status);
            channel.port1.onmessage = () => {
                const resolve = resume;
                resume = undefined;
                resolve?.();
            };
            const resultPromise = this.dialog(
                '이미지 내보내기',
                [
                    { key: 'name', label: '파일 이름', value: this.name.replace(/\.[^.]+$/, '') || '그림' },
                    { key: 'format', label: '형식', options: ['png', 'jpg', 'bmp'], value: 'png' },
                    { key: 'matte', label: 'JPG/BMP 바탕색', type: 'color', value: '#ffffff' },
                ],
                '내보내기',
                '',
                panel,
            );
            const form = panel.closest('form');
            if (!form) {
                await resultPromise;
                throw Error('내보내기 창을 열 수 없습니다.');
            }
            const format = form.elements.namedItem('format') as HTMLSelectElement,
                matte = form.elements.namedItem('matte') as HTMLInputElement,
                confirm = form.querySelector<HTMLButtonElement>('button[value="ok"]')!;
            let flattened: Uint8ClampedArray | undefined, output: ImageData | undefined;
            const failPreview = (error: unknown) => {
                if (closed) return;
                flattened = undefined;
                output = undefined;
                canvas.width = canvas.height = 1;
                panel.dataset.state = 'error';
                status.textContent =
                    '미리보기를 만들 수 없습니다. ' +
                    (error instanceof Error ? error.message : String(error));
            };
            const repaint = () => {
                matte.disabled = format.value === 'png';
                if (!flattened || !output || closed) return;
                const background = this.color(matte.value);
                for (let i = 0; i < flattened.length; i += 4) {
                    const alpha = flattened[i + 3] / 255;
                    for (let c = 0; c < 3; c++)
                        output.data[i + c] =
                            format.value === 'png'
                                ? flattened[i + c]
                                : Math.round(flattened[i + c] * alpha + background[c] * (1 - alpha));
                    output.data[i + 3] = format.value === 'png' ? flattened[i + 3] : 255;
                }
                canvas.getContext('2d')!.putImageData(output, 0, 0);
                status.textContent =
                    (format.value === 'png'
                        ? 'PNG는 투명도를 유지합니다. '
                        : '투명한 부분에 선택한 바탕색을 적용합니다. JPG는 저장 시 색이 조금 달라질 수 있습니다. ') +
                    '축소 미리보기에서는 작은 세부와 가장자리가 실제 출력과 다를 수 있습니다.';
            };
            form.addEventListener('input', () => {
                try {
                    repaint();
                } catch (error) {
                    failPreview(error);
                }
            });
            confirm.disabled = true;
            repaint();
            build = (async () => {
                await checkpoint();
                if (this.composing) throw Error('문자 조합을 먼저 확정하세요.');
                const q = selection?.modified ? selection : undefined,
                    width = Math.max(state.width, q ? q.x + q.width : 0),
                    height = Math.max(state.height, q ? q.y + q.height : 0),
                    scale = Math.min(1, 192 / width, 192 / height);
                validateSize(width, height, state.layers.length, runtimeProfile);
                canvas.width = Math.max(1, Math.round(width * scale));
                canvas.height = Math.max(1, Math.round(height * scale));
                canvas.style.width = `${(192 * canvas.width) / Math.max(canvas.width, canvas.height)}px`;
                const w = canvas.width,
                    h = canvas.height,
                    flat = new Uint8ClampedArray(w * h * 4),
                    layerPixels = new Uint8ClampedArray(flat.length),
                    hasText = Boolean(editor?.value && this.textPoint),
                    hasShape =
                        (this.tool === 'curve' && this.points.length === 2) ||
                        (this.tool === 'polygon' && this.points.length >= 3),
                    pending = Boolean(q || hasText || hasShape);
                let layout: TextLayout | undefined;
                if (hasText) {
                    await new Promise<void>((resolve, reject) => {
                        resume = resolve;
                        void document.fonts
                            .load(
                                `${this.fontItalic ? 'italic ' : ''}${this.fontBold ? 'bold ' : ''}${this.fontSize}px ${this.fontFamily}`,
                            )
                            .then(() => resolve(), reject);
                    });
                    resume = undefined;
                    if (closed) throw Error('취소했습니다.');
                    await checkpoint();
                    const steps = this.textLayoutSteps();
                    try {
                        let step = steps.next();
                        while (!step.done) {
                            await checkpoint();
                            step = steps.next();
                        }
                        layout = step.value;
                    } finally {
                        steps.return(undefined as never);
                    }
                }
                for (let layerIndex = 0; layerIndex < state.layers.length; layerIndex++) {
                    const layer = state.layers[layerIndex],
                        active = layerIndex === state.active;
                    if (!layer.visible && !(active && pending)) continue;
                    for (let y = 0; y < h; y++) {
                        const sy = Math.min(height - 1, Math.max(0, Math.ceil(((y + 0.5) * height) / h) - 1));
                        for (let x = 0; x < w; x++) {
                            const sx = Math.min(
                                    width - 1,
                                    Math.max(0, Math.ceil(((x + 0.5) * width) / w) - 1),
                                ),
                                i = (y * w + x) * 4,
                                source = (sy * state.width + sx) * 4;
                            for (let c = 0; c < 4; c++)
                                layerPixels[i + c] =
                                    sx < state.width && sy < state.height
                                        ? layer.pixels[source + c]
                                        : layerIndex === 0
                                          ? state.background[c]
                                          : 0;
                            if (active && q) {
                                const cut = q.source;
                                if (
                                    cut &&
                                    sx >= cut.x &&
                                    sy >= cut.y &&
                                    sx < cut.x + cut.width &&
                                    sy < cut.y + cut.height &&
                                    (!q.sourceMask || q.sourceMask[(sy - cut.y) * cut.width + sx - cut.x])
                                )
                                    for (let c = 0; c < 4; c++)
                                        layerPixels[i + c] =
                                            state.layers.length === 1 ? state.background[c] : 0;
                                const tx = sx - q.x,
                                    ty = sy - q.y;
                                if (tx >= 0 && ty >= 0 && tx < q.width && ty < q.height) {
                                    const j = (ty * q.width + tx) * 4,
                                        a = q.pixels[j + 3] / 255;
                                    if (a) {
                                        const b = layerPixels[i + 3] / 255,
                                            alpha = a + b * (1 - a);
                                        for (let c = 0; c < 3; c++)
                                            layerPixels[i + c] = Math.round(
                                                (q.pixels[j + c] * a + layerPixels[i + c] * b * (1 - a)) /
                                                    alpha,
                                            );
                                        layerPixels[i + 3] = Math.round(alpha * 255);
                                    }
                                }
                            }
                        }
                        if (y % 16 === 15) await checkpoint();
                    }
                    if (active && (layout || hasShape)) {
                        const overlay = createSurface(w, h);
                        try {
                            const ctx = context2D(overlay);
                            for (const kind of ['text', 'shape']) {
                                if ((kind === 'text' && !layout) || (kind === 'shape' && !hasShape)) continue;
                                overlay.width = w;
                                overlay.height = h;
                                ctx.setTransform(w / width, 0, 0, h / height, 0, 0);
                                if (kind === 'text') {
                                    ctx.translate(
                                        Math.floor(this.textPoint!.x),
                                        Math.floor(this.textPoint!.y),
                                    );
                                    this.paintText(ctx, layout!);
                                } else this.paintShape(ctx, this.points[0], this.points.at(-1)!, this.tool);
                                const pixels = ctx.getImageData(0, 0, w, h).data;
                                for (let i = 0; i < pixels.length; i += 4) {
                                    const a = pixels[i + 3] / 255;
                                    if (!a) continue;
                                    const b = layerPixels[i + 3] / 255,
                                        alpha = a + b * (1 - a);
                                    for (let c = 0; c < 3; c++)
                                        layerPixels[i + c] = Math.round(
                                            (pixels[i + c] * a + layerPixels[i + c] * b * (1 - a)) / alpha,
                                        );
                                    layerPixels[i + 3] = Math.round(alpha * 255);
                                }
                                await checkpoint();
                            }
                        } finally {
                            overlay.width = overlay.height = 0;
                        }
                    }
                    for (let i = 0; i < flat.length; i += 4) {
                        const a = layerPixels[i + 3] / 255;
                        if (!a) continue;
                        const b = flat[i + 3] / 255,
                            alpha = a + b * (1 - a);
                        for (let c = 0; c < 3; c++)
                            flat[i + c] = Math.round(
                                (layerPixels[i + c] * a + flat[i + c] * b * (1 - a)) / alpha,
                            );
                        flat[i + 3] = Math.round(alpha * 255);
                    }
                    await checkpoint();
                }
                flattened = flat;
                output = new ImageData(layerPixels, w, h);
                repaint();
                panel.dataset.state = 'ready';
            })()
                .catch(failPreview)
                .finally(() => {
                    if (!closed) confirm.disabled = false;
                });
            const result = await resultPromise;
            closed = true;
            resume?.();
            await build;
            if (!result) return;
            if (!current() || JSON.stringify([points, curveControls]) !== pointSignature)
                throw Error('그림이 변경되었습니다. 내보내기를 다시 실행하세요.');
            const candidate = this.pendingState();
            await this.task('이미지 준비 중', async (signal) => {
                const bytes = await exportBytes(
                    candidate,
                    result.format,
                    this.color(result.matte || matte.value),
                    signal,
                    runtimeProfile,
                );
                if (signal.aborted) throw Error('취소했습니다.');
                const name = result.name.replace(/[\\/\0]/g, '_') + '.' + result.format;
                if (isDesktop())
                    await saveNative(bytes, name, signal, {
                        generation: this.epoch,
                        project: false,
                        saveAs: true,
                    });
                else
                    this.showDownload(
                        bytes,
                        name,
                        result.format === 'jpg' ? 'image/jpeg' : 'image/' + result.format,
                    );
            });
        } finally {
            closed = true;
            resume?.();
            await build;
            channel.port1.close();
            channel.port2.close();
            canvas.width = canvas.height = 0;
        }
    }
    async copy(cut = false): Promise<void> {
        if (this.composing) throw Error('문자 조합을 먼저 확정하세요.');
        if (this.editor) {
            const editor = this.editor,
                value = editor.value,
                start = editor.selectionStart,
                end = editor.selectionEnd;
            if (start === end) return;
            if (!navigator.clipboard?.writeText) throw Error('문자 클립보드를 사용할 수 없습니다.');
            await navigator.clipboard.writeText(value.slice(start, end));
            if (cut) {
                if (this.busy || editor !== this.editor || editor.value !== value)
                    throw Error('문자 편집 상태가 변경되어 잘라내지 않았습니다.');
                editor.setRangeText('', start, end, 'start');
            }
            return;
        }
        const q = this.selection,
            owner = this.doc.state,
            active = owner.active,
            state = q ? undefined : this.pendingState(),
            revision = this.doc.revision,
            epoch = this.epoch;
        const copy: State = q
            ? {
                  width: q.width,
                  height: q.height,
                  background: [0, 0, 0, 0],
                  active: 0,
                  layers: [{ name: '선택', visible: true, pixels: q.pixels.slice() }],
              }
            : cut
              ? { ...state!, active: 0, layers: [{ ...state!.layers[active], visible: true }] }
              : state!;
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
            throw Error('클립보드를 사용할 수 없습니다. 이미지 내보내기를 사용하세요.');
        await this.task('클립보드 준비 중', async (signal) => {
            if (!q && cut && this.transparentSelection) {
                const pixels = copy.layers[0].pixels,
                    key = this.secondary,
                    keyRed = Math.round((key[0] * key[3]) / 255),
                    keyGreen = Math.round((key[1] * key[3]) / 255),
                    keyBlue = Math.round((key[2] * key[3]) / 255);
                // Change only the owned clipboard candidate; delivery failure preserves the document.
                for (let i = 0; i < pixels.length; i += 4)
                    if (
                        pixels[i + 3] === key[3] &&
                        Math.round((pixels[i] * key[3]) / 255) === keyRed &&
                        Math.round((pixels[i + 1] * key[3]) / 255) === keyGreen &&
                        Math.round((pixels[i + 2] * key[3]) / 255) === keyBlue
                    )
                        pixels[i + 3] = 0;
            }
            const png = runCodec('png-write', copy, undefined, signal, runtimeProfile).then(
                (result) => new Blob([result.bytes! as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
            );
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
                await png;
            } catch (error) {
                this.abort?.abort();
                await png.catch(() => {});
                throw error;
            }
            if (
                signal.aborted ||
                this.epoch !== epoch ||
                this.doc.revision !== revision ||
                this.doc.state !== owner ||
                owner.active !== active ||
                this.selection !== q
            )
                throw Error('편집 상태가 변경됐습니다. 잘라내기는 적용하지 않았습니다.');
            if (cut) {
                if (q) this.commitPending('잘라내기', this.pendingState(false));
                else {
                    const candidate = state!;
                    const pixels = new Uint8ClampedArray(candidate.width * candidate.height * 4),
                        color = new Uint32Array(
                            new Uint8ClampedArray(
                                candidate.layers.length === 1 ? candidate.background : [0, 0, 0, 0],
                            ).buffer,
                        )[0];
                    if (color) new Uint32Array(pixels.buffer).fill(color);
                    candidate.layers[active].pixels = pixels;
                    this.commitPending('잘라내기', candidate);
                }
            }
        });
    }
    async paste(file?: File): Promise<void> {
        if (this.editor && !file) {
            if (!navigator.clipboard?.readText) throw Error('문자 클립보드를 사용할 수 없습니다.');
            const editor = this.editor,
                value = editor.value,
                start = editor.selectionStart,
                end = editor.selectionEnd,
                epoch = this.epoch;
            const text = await navigator.clipboard.readText();
            if (
                editor !== this.editor ||
                !editor.isConnected ||
                editor.value !== value ||
                editor.selectionStart !== start ||
                editor.selectionEnd !== end ||
                this.epoch !== epoch ||
                this.busy
            )
                throw Error('문자 편집 상태가 변경되어 붙여넣지 않았습니다.');
            if (value.length - (end - start) + text.length > 65536) throw Error('문자는 최대 65536자입니다.');
            editor.setRangeText(text, start, end, 'end');
            return;
        }
        const owner = this.doc.state,
            revision = this.doc.revision,
            epoch = this.epoch;
        if (!file) {
            if (!navigator.clipboard?.read)
                throw Error('클립보드를 사용할 수 없습니다. Ctrl/Cmd+V 또는 사진 삽입을 사용하세요.');
            await this.task('클립보드 읽는 중', async (signal) => {
                const items = await navigator.clipboard.read();
                for (const item of items) {
                    const type = item.types.find((t) =>
                        ['image/png', 'image/jpeg', 'image/bmp', 'image/gif'].includes(t),
                    );
                    if (!type) continue;
                    const blob = await item.getType(type);
                    if (signal.aborted) throw Error('취소했습니다.');
                    file = new File([blob], '붙여넣기', { type });
                    return;
                }
                throw Error('클립보드에 지원하는 이미지가 없습니다.');
            });
        }
        if (this.doc.state !== owner || this.doc.revision !== revision || this.epoch !== epoch)
            throw Error('편집 상태가 변경되어 붙여넣지 않았습니다.');
        await this.loadFile(file!, true);
    }
    async autoRecover(): Promise<void> {
        if (
            this.recoveryBusy ||
            this.busy ||
            this.doc.stroke ||
            !this.doc.dirty ||
            this.doc.revision === this.recoveredRevision
        )
            return;
        const revision = this.doc.revision,
            epoch = this.epoch;
        this.recoveryBusy = true;
        try {
            await this.nativeReady;
            if (this.doc.revision !== revision || this.epoch !== epoch) return;
            const snapshot = cloneState(this.doc.state);
            const bytes = (await runCodec('project-write', snapshot, undefined, undefined, runtimeProfile))
                .bytes!;
            if (this.doc.revision !== revision || this.epoch !== epoch) return;
            await this.recovery.request('write', undefined, bytes, this.name);
            if (this.doc.revision === revision && this.epoch === epoch) this.recoveredRevision = revision;
        } catch (error) {
            if (this.epoch === epoch)
                this.message('복구 저장 실패: ' + (error instanceof Error ? error.message : String(error)));
        } finally {
            this.recoveryBusy = false;
        }
    }
    async openRecovery(startup = false): Promise<void> {
        if (this.recoveryOpening) return;
        this.recoveryOpening = true;
        try {
            await this.nativeReady;
            if (
                startup &&
                (this.busy ||
                    this.drag ||
                    this.doc.stroke ||
                    this.doc.dirty ||
                    this.hasPending() ||
                    document.querySelector('dialog[open]'))
            )
                return;
            const epoch = this.epoch,
                revision = this.doc.revision;
            let entries: RecoveryEntry[];
            try {
                entries = (await this.recovery.request('list')) as RecoveryEntry[];
            } catch (error) {
                if (this.epoch !== epoch) return;
                this.message(
                    (isDesktop()
                        ? '파일 복구 저장소에 접근할 수 없습니다. '
                        : '브라우저 복구 저장소에 접근할 수 없습니다. 프로젝트를 직접 다운로드하세요. ') +
                        (error instanceof Error ? error.message : String(error)),
                );
                return;
            }
            if (
                this.epoch !== epoch ||
                (startup &&
                    (this.busy ||
                        this.drag ||
                        this.doc.stroke ||
                        this.doc.revision !== revision ||
                        this.doc.dirty ||
                        this.hasPending() ||
                        document.querySelector('dialog[open]')))
            )
                return;
            if (!entries.length) {
                if (this.recovery.warnings.length) this.message(this.recovery.warnings.join(' '));
                else if (!startup) this.message('복구 사본이 없습니다.');
                return;
            }
            const result = await this.dialog(
                isDesktop() ? '이 기기의 복구 사본' : '브라우저 복구 사본',
                [
                    {
                        key: 'entry',
                        label: '시각 · 이름',
                        options: entries.map(
                            (e, i) =>
                                `${i + 1}. ${new Date(e.at).toLocaleString()} · ${e.source === 'legacy' ? '이전 Qt (읽기 전용) · ' : e.source === 'browser' && isDesktop() ? '이전 웹 저장소 · ' : ''}${e.name}`,
                        ),
                        value: '',
                    },
                    {
                        key: 'action',
                        label: '동작',
                        options: entries.every((entry) => entry.readOnly)
                            ? ['열기']
                            : ['열기', '선택 사본 삭제'],
                        value: '열기',
                    },
                ],
                '확인',
                this.recovery.warnings.join(' '),
            );
            if (!result) return;
            const entry = entries[parseInt(result.entry) - 1];
            if (!entry) return;
            if (result.action === '선택 사본 삭제') {
                await this.recovery.request('clear', entry);
                this.message('선택 사본을 삭제했습니다.');
                return;
            }
            let state: State | undefined;
            await this.task('복구 사본 읽는 중', async (signal) => {
                signal.throwIfAborted();
                const bytes = await this.recovery.read(entry);
                signal.throwIfAborted();
                state = (await runCodec('project-read', undefined, bytes, signal, runtimeProfile)).state;
            });
            if (state && (await this.replacementAllowed())) {
                await this.replaceDocument(state, entry.name, false);
                this.message('복구했습니다. 프로젝트를 별도로 저장하세요.');
            }
        } finally {
            this.recoveryOpening = false;
        }
    }
    async command(command: string): Promise<void> {
        await this.nativeReady;
        if (this.busy || this.drag || this.doc.stroke) throw Error('현재 작업을 마친 뒤 실행하세요.');
        if (command === 'menu' || command === 'tools') {
            await this.menu(command);
            return;
        }
        if (command === 'undo') {
            const pending = this.hasPending(),
                change = this.doc.history[this.doc.cursor - 1];
            if (this.hasPending()) {
                this.selection = undefined;
                this.editor?.remove();
                this.editor = undefined;
                this.points = [];
                this.curveControls = [];
            } else this.doc.undo();
            if (!pending && change?.tiles && change.layer !== undefined)
                this.draw(false, this.doc.state.layers[change.layer].pixels, change.tiles);
            else this.draw(!pending && !!change && !change.metadata);
            return;
        }
        if (command === 'redo') {
            if (this.hasPending()) return;
            const change = this.doc.history[this.doc.cursor];
            this.doc.redo();
            if (change?.tiles && change.layer !== undefined)
                this.draw(false, this.doc.state.layers[change.layer].pixels, change.tiles);
            else this.draw(!!change && !change.metadata);
            return;
        }
        if (command === 'open' || command === 'insert') {
            await this.openFile(command === 'insert');
            return;
        }
        if (command === 'save' || command === 'save-as') {
            await this.saveProject(command === 'save-as');
            return;
        }
        if (command === 'export') {
            await this.exportImage();
            return;
        }
        if (command === 'recover') {
            await this.openRecovery();
            return;
        }
        if (command === 'copy' || command === 'cut') {
            await this.copy(command === 'cut');
            return;
        }
        if (command === 'paste') {
            await this.paste();
            return;
        }
        if (command === 'zoom-in') {
            this.changeZoom(this.zoom * 1.25);
            return;
        }
        if (command === 'zoom-out') {
            this.changeZoom(this.zoom / 1.25);
            return;
        }
        if (command === 'fit') {
            this.fit();
            return;
        }
        if (command === 'swap') {
            [this.foreground, this.secondary] = [this.secondary, this.foreground];
            return;
        }
        if (command === 'properties' || command === 'layers') {
            const panel = this.root.querySelector('.inspector')!;
            panel.classList.add('open');
            panel.scrollTop =
                command === 'layers'
                    ? panel.querySelector<HTMLElement>('.layers')!.offsetTop -
                      panel.querySelector<HTMLElement>('h2')!.offsetHeight
                    : 0;
            return;
        }
        if (command === 'close-panel') {
            this.root.querySelector('.inspector')!.classList.remove('open');
            this.canvas.focus();
            return;
        }
        if (command === 'settings') {
            const result = await this.dialog('환경설정', [
                {
                    key: 'skin',
                    label: '스킨',
                    options: ['Studio Dark', 'Classic 98'],
                    value: this.skin === 'classic' ? 'Classic 98' : 'Studio Dark',
                },
                {
                    key: 'density',
                    label: '조작부 크기',
                    options: ['자동', '터치', '마우스'],
                    value: this.density === 'touch' ? '터치' : this.density === 'mouse' ? '마우스' : '자동',
                },
            ]);
            if (result) {
                this.skin = result.skin === 'Classic 98' ? 'classic' : 'studio';
                this.density =
                    result.density === '터치' ? 'touch' : result.density === '마우스' ? 'mouse' : 'auto';
                this.applyPreferences();
            }
            return;
        }
        if (command === 'new') {
            const result = await this.dialog('새 그림', [
                {
                    key: 'width',
                    label: '너비',
                    type: 'number',
                    min: 1,
                    max: runtimeProfile.dimension,
                    value: '800',
                },
                {
                    key: 'height',
                    label: '높이',
                    type: 'number',
                    min: 1,
                    max: runtimeProfile.dimension,
                    value: '600',
                },
                { key: 'background', label: '배경', options: ['투명', '흰색'], value: '투명' },
            ]);
            if (result) {
                const state = createState(
                    Number(result.width),
                    Number(result.height),
                    result.background === '투명' ? [0, 0, 0, 0] : [255, 255, 255, 255],
                    runtimeProfile,
                );
                if (await this.replacementAllowed()) await this.replaceDocument(state, '제목 없음');
            }
            return;
        }
        if (command === 'text-options') {
            const result = await this.dialog('문자 설정', [
                {
                    key: 'size',
                    label: '크기 (px)',
                    type: 'number',
                    min: 6,
                    max: 256,
                    value: String(this.fontSize),
                },
                {
                    key: 'family',
                    label: '글꼴',
                    options: ['sans-serif', 'serif', 'monospace'],
                    value: this.fontFamily,
                },
                {
                    key: 'bold',
                    label: '굵게',
                    options: ['아니요', '예'],
                    value: this.fontBold ? '예' : '아니요',
                },
                {
                    key: 'italic',
                    label: '기울임',
                    options: ['아니요', '예'],
                    value: this.fontItalic ? '예' : '아니요',
                },
                {
                    key: 'background',
                    label: '문자 배경',
                    options: ['투명', '보조색'],
                    value: this.textBackground ? '보조색' : '투명',
                },
            ]);
            if (result) {
                this.fontSize = Number(result.size);
                this.fontFamily = result.family;
                this.fontBold = result.bold === '예';
                this.fontItalic = result.italic === '예';
                this.textBackground = result.background === '보조색';
                this.placeEditor();
            }
            return;
        }
        if (command === 'select-all') {
            this.settle();
            this.tool = 'select';
            this.makeSelection(0, 0, this.doc.state.width, this.doc.state.height);
            return;
        }
        if (command === 'delete') {
            if (this.selection) {
                const candidate = this.pendingState(false);
                this.commitPending('선택 삭제', candidate);
                this.draw(true);
            }
            return;
        }
        if (command === 'selection-size') {
            if (!this.selection) throw Error('먼저 영역을 선택하세요.');
            const q = this.selection,
                result = await this.dialog('선택 크기', [
                    {
                        key: 'width',
                        label: '너비',
                        type: 'number',
                        min: 1,
                        max: runtimeProfile.dimension,
                        value: String(q.width),
                    },
                    {
                        key: 'height',
                        label: '높이',
                        type: 'number',
                        min: 1,
                        max: runtimeProfile.dimension,
                        value: String(q.height),
                    },
                ]);
            if (result) {
                if (Number(result.width) === q.width && Number(result.height) === q.height) return;
                await this.transformSelection({
                    kind: 'resize',
                    width: Number(result.width),
                    height: Number(result.height),
                    scale: true,
                    smooth: false,
                });
            }
            return;
        }
        if (command === 'crop') {
            if (!this.selection) throw Error('먼저 영역을 선택하세요.');
            const q = this.selection,
                x = Math.max(0, q.x),
                y = Math.max(0, q.y),
                width = q.x + q.width - x,
                height = q.y + q.height - y;
            if (width <= 0 || height <= 0) return;
            await this.editDocument('자르기', { kind: 'crop', x, y, width, height });
            return;
        }
        if (['rotate-right', 'rotate-left', 'flip-x', 'flip-y'].includes(command)) {
            if (this.selection) {
                await this.transformSelection({ kind: 'transform', operation: command });
            } else {
                await this.editDocument('변형', { kind: 'transform', operation: command });
                this.fit();
            }
            this.draw(true);
            return;
        }
        if (command === 'canvas-size' || command === 'image-size') {
            const s = this.doc.state,
                result = await this.dialog(command === 'canvas-size' ? '캔버스 크기' : '이미지 크기', [
                    {
                        key: 'width',
                        label: '너비',
                        type: 'number',
                        min: 1,
                        max: runtimeProfile.dimension,
                        value: String(s.width),
                    },
                    {
                        key: 'height',
                        label: '높이',
                        type: 'number',
                        min: 1,
                        max: runtimeProfile.dimension,
                        value: String(s.height),
                    },
                    ...(command === 'image-size'
                        ? [{ key: 'smooth', label: '보간', options: ['픽셀', '부드럽게'], value: '픽셀' }]
                        : []),
                ]);
            if (result) {
                await this.editDocument('크기 변경', {
                    kind: 'resize',
                    width: Number(result.width),
                    height: Number(result.height),
                    scale: command === 'image-size',
                    smooth: result.smooth === '부드럽게',
                });
                this.fit();
                this.draw(true);
            }
            return;
        }
        if (command === 'background') {
            const result = await this.dialog('문서 지우기·확장 바탕', [
                {
                    key: 'mode',
                    label: '바탕',
                    options: ['투명', '색상'],
                    value: this.doc.state.background[3] ? '색상' : '투명',
                },
                { key: 'color', label: '색상', type: 'color', value: this.hex(this.doc.state.background) },
            ]);
            if (result) {
                const background: Color = result.mode === '투명' ? [0, 0, 0, 0] : this.color(result.color);
                if (this.hasPending())
                    this.editPending('문서 바탕', (state) => {
                        state.background = background;
                    });
                else this.doc.editMetadata('문서 바탕', { kind: 'background', background });
                this.draw();
                this.message('새로 지우거나 확장할 영역에 적용됩니다. 이미 칠한 픽셀은 유지됩니다.');
            }
            return;
        }
        if (command === 'clear') {
            const result = await this.dialog('활성 레이어의 픽셀을 지울까요?', [], '지우기');
            if (result) await this.editDocument('전체 지우기', { kind: 'clear' });
            return;
        }
        if (command === 'invert') {
            await this.editDocument('색 반전', { kind: 'invert' });
            return;
        }
        if (command === 'shear') {
            const result = await this.dialog('가로 기울이기', [
                { key: 'angle', label: '각도 (-60~60)', type: 'number', min: -60, max: 60, value: '15' },
            ]);
            if (result) {
                const angle = Number(result.angle);
                if (Math.abs(Math.tan((angle * Math.PI) / 180)) <= 1e-12) return;
                if (this.selection) {
                    await this.transformSelection({ kind: 'shear', angle });
                } else {
                    await this.editDocument('기울이기', { kind: 'shear', angle });
                    this.fit();
                    this.draw(true);
                }
            }
            return;
        }
        if (command.startsWith('layer-')) {
            if (command === 'layer-rename') {
                const l = this.doc.state.layers[this.doc.state.active],
                    result = await this.dialog('레이어 이름', [
                        { key: 'name', label: '이름', value: l.name },
                    ]);
                if (result) {
                    if (this.hasPending())
                        this.editPending('레이어 이름', (s) => {
                            s.layers[s.active].name = result.name;
                        });
                    else
                        this.doc.editMetadata('레이어 이름', {
                            kind: 'layer-name',
                            layer: this.doc.state.active,
                            name: result.name,
                        });
                }
                return;
            }
            if (command === 'layer-merge') {
                if (this.doc.state.active > 0) await this.editDocument('레이어 병합', { kind: 'merge' });
                return;
            }
            if (!this.hasPending() && (command === 'layer-up' || command === 'layer-down')) {
                const layer = this.doc.state.active,
                    to = layer + (command === 'layer-up' ? 1 : -1);
                if (to >= 0 && to < this.doc.state.layers.length)
                    this.doc.editMetadata('레이어 순서', { kind: 'layer-reorder', layer, to });
                this.draw();
                return;
            }
            this.editPending('레이어', (s) => {
                const i = s.active;
                if (command === 'layer-add') {
                    validateSize(s.width, s.height, s.layers.length + 1, runtimeProfile);
                    s.layers.splice(i + 1, 0, {
                        name: '레이어 ' + (s.layers.length + 1),
                        visible: true,
                        pixels: new Uint8ClampedArray(s.width * s.height * 4),
                    });
                    s.active = i + 1;
                } else if (command === 'layer-delete') {
                    if (s.layers.length < 2) throw Error('마지막 레이어는 삭제할 수 없습니다.');
                    s.layers.splice(i, 1);
                    s.active = Math.min(i, s.layers.length - 1);
                } else if (command === 'layer-up' && i + 1 < s.layers.length) {
                    [s.layers[i], s.layers[i + 1]] = [s.layers[i + 1], s.layers[i]];
                    s.active++;
                } else if (command === 'layer-down' && i > 0) {
                    [s.layers[i], s.layers[i - 1]] = [s.layers[i - 1], s.layers[i]];
                    s.active--;
                }
            });
            this.draw(true);
            return;
        }
        if (command === 'help') {
            const content = document.createElement('div');
            content.className = 'help-shortcuts';
            for (const [keys, description] of [
                ['B / N / E / V / H', '브러시 / 연필 / 지우개 / 선택 / 화면 이동'],
                ['Ctrl 또는 Cmd + V', '클립보드 이미지 바로 붙여넣기'],
                ['Ctrl 또는 Cmd + S', '프로젝트 저장 · 이미지는 내보내기로 저장'],
                ['Ctrl 또는 Cmd + Z / Shift+Z', '실행 취소 / 다시 실행'],
                ['Enter / Esc', '선택·도형 확정 / 현재 조작 취소'],
                ['Ctrl 또는 Cmd + Enter', '문자 입력 확정'],
                ['방향키 / Shift+방향키', '선택 이동 1px / 10px'],
                ['캔버스 가장자리 핸들', '그림의 픽셀 크기를 유지하며 캔버스 영역 변경'],
                ['두 손가락', '화면 이동 · 확대/축소'],
            ]) {
                const line = document.createElement('p'),
                    key = document.createElement('strong');
                key.textContent = keys;
                line.append(key, document.createTextNode(' — ' + description));
                content.append(line);
            }
            await this.dialog('사용 방법', [], '닫기', '', content);
        }
    }

    keyboard(e: KeyboardEvent): void {
        if (!this.nativeInitialized) return;
        const input =
            e.target instanceof HTMLInputElement ||
            e.target instanceof HTMLTextAreaElement ||
            e.target instanceof HTMLSelectElement;
        if (this.busy) {
            if (e.key === 'Escape') this.abort?.abort();
            e.preventDefault();
            return;
        }
        if (document.querySelector('dialog[open]')) return;
        if (e.isComposing || this.composing) return;
        if (this.drag?.mode === 'canvas-resize') {
            e.preventDefault();
            if (e.key === 'Escape') {
                this.cancelPointer();
                this.message('캔버스 크기 변경을 취소했습니다.');
            }
            return;
        }
        if (this.selectionResize && e.key !== 'Escape') {
            e.preventDefault();
            this.message('선택 크기 변경을 마치거나 Esc로 취소하세요.');
            return;
        }
        const meta = e.ctrlKey || e.metaKey;
        if (e.key === 'Escape') {
            e.preventDefault();
            this.cancelPointer();
            this.selection = undefined;
            this.editor?.remove();
            this.editor = undefined;
            this.points = [];
            this.curveControls = [];
            this.draw(true);
            this.sync();
            return;
        }
        if (this.editor && meta && e.key === 'Enter') {
            e.preventDefault();
            this.run(() => this.settle());
            return;
        }
        if (input) return;
        if (meta && e.key.toLowerCase() === 'v') return;
        let command = '';
        if (meta) {
            const key = e.key.toLowerCase();
            command =
                key === 'z'
                    ? e.shiftKey
                        ? 'redo'
                        : 'undo'
                    : key === 'y'
                      ? 'redo'
                      : key === 's'
                        ? e.shiftKey
                            ? 'save-as'
                            : 'save'
                        : key === 'o'
                          ? 'open'
                          : key === 'n'
                            ? 'new'
                            : key === 'c'
                              ? 'copy'
                              : key === 'x'
                                ? 'cut'
                                : key === 'a'
                                  ? 'select-all'
                                  : '';
        } else if (e.key === 'Enter') {
            if (e.target instanceof HTMLButtonElement) return;
            e.preventDefault();
            this.run(() => this.settle());
            return;
        } else if (e.key === 'Delete' || e.key === 'Backspace') command = 'delete';
        else if (this.selection && e.key.startsWith('Arrow')) {
            e.preventDefault();
            this.run(() => {
                const q = this.selection!,
                    step = e.shiftKey ? 10 : 1,
                    x = q.x + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0),
                    y = q.y + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0);
                validateSize(
                    Math.max(this.doc.state.width, x + q.width),
                    Math.max(this.doc.state.height, y + q.height),
                    this.doc.state.layers.length,
                    runtimeProfile,
                );
                q.x = x;
                q.y = y;
                q.modified =
                    !q.source ||
                    q.x !== q.source.x ||
                    q.y !== q.source.y ||
                    q.width !== q.source.width ||
                    q.height !== q.source.height ||
                    q.pixels !== q.originalPixels;
                this.draw();
            });
            return;
        } else {
            const definition = toolDefinitions.find(
                (t) => t[2] && t[2].toLowerCase() === e.key.toLowerCase(),
            );
            if (definition) {
                e.preventDefault();
                this.run(() => this.chooseTool(definition[0]));
                return;
            }
            if ((e.key === '[' || e.key === ']') && this.tool !== 'pencil') {
                this.size = Math.max(1, Math.min(100, this.size + (e.key === '[' ? -1 : 1)));
                this.sync(false);
                return;
            }
        }
        if (command) {
            e.preventDefault();
            this.run(() => this.command(command));
        }
    }
}
export type { Studio };
const studio = new Studio();
if (window.__TAURI__?.core)
    void (async () => {
        if (!(await window.__TAURI__!.core.invoke<boolean>('runtime_ready'))) return;
        try {
            const { runNativeSmoke } = await import('./platform/native-smoke');
            await runNativeSmoke(studio, runtimeProfile);
        } catch (error) {
            await window.__TAURI__!.core.invoke('smoke_result', { ok: false, error: String(error) });
        }
    })();
