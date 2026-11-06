export const toolDefinitions = [
    ['brush', '브러시', 'B', 'M9 14l7-10 4 4-10 8M10 16c0 5-5 5-7 4 3-1 0-4 4-5z'],
    ['pencil', '연필', 'N', 'M4 16L16 4l4 4L8 20l-5 1zM14 6l4 4'],
    ['eraser', '지우개', 'E', 'M3 14l9-10 9 8-8 9H9zM7 10l10 8M13 21h8'],
    ['fill', '채우기', 'G', 'M3 11l9-8 9 9-9 8zM3 11h18M7 2l5 6M20 17c-4 5 3 6 0 0'],
    ['picker', '스포이트', 'I', 'M4 17l10-10 3 3L7 20H3zM13 5l5-3 4 4-3 5z'],
    ['spray', '스프레이', '', 'M10 9h9v12h-9zM12 5h5v4M12 2h4M3 4h1M6 7h1M3 10h1'],
    ['color-eraser', '지정 색 교체', '', 'M3 14l8-9 9 8-7 8H9zM5 4h4M7 2v4M16 3h5M19 1l2 2-2 2'],
    ['line', '직선', '', 'M3 20L21 4M3 17v3h3M18 4h3v3'],
    ['curve', '곡선', '', 'M3 19C3 2 21 22 21 4M2 18h3v3H2zM19 2h3v3h-3z'],
    ['rectangle', '사각형', '', 'M3 5h18v14H3z'],
    ['roundrect', '둥근 사각형', '', 'M7 4h10q4 0 4 4v8q0 4-4 4H7q-4 0-4-4V8q0-4 4-4z'],
    ['ellipse', '타원', '', 'M21 12a9 7 0 1 1-18 0 9 7 0 1 1 18 0'],
    ['polygon', '다각형', '', 'M3 20L7 3l14 5-6 6 5 6z'],
    ['select', '사각 선택', 'V', 'M3 7V3h4M10 3h4M17 3h4v4M21 10v4M21 17v4h-4M14 21h-4M7 21H3v-4M3 14v-4'],
    ['lasso', '자유 선택', '', 'M5 18C-2 6 12 0 20 6s-4 17-12 12c-7-5-3-1 2 4'],
    ['text', '문자', 'T', 'M3 5h18M12 5v16M7 21h10M3 5v4M21 5v4'],
    ['pan', '화면 이동', 'H', 'M5 13V9q0-3 3-1V4q0-3 3-1v7-7q0-2 3-1v8-5q0-2 3-1v7q4-4 5-1l-4 11H9z'],
] as const;
export type Tool = (typeof toolDefinitions)[number][0];
const commands: Record<string, string> = {
    undo: 'M9 5L3 11l6 6M3 11h11q7 0 7 8',
    redo: 'M15 5l6 6-6 6M21 11H10q-7 0-7 8',
    open: 'M3 20V5h7l3 3h8v12zM3 10h18',
    save: 'M4 3h14l3 3v15H3V3zM8 3v6h8V3M7 21v-8h10v8',
    export: 'M12 3v13M7 11l5 5 5-5M3 17v4h18v-4',
    layers: 'M12 3l10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5',
    settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
    menu: 'M3 6h18M3 12h18M3 18h18',
    plus: 'M12 4v16M4 12h16',
    minus: 'M4 12h16',
    fit: 'M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6',
    close: 'M5 5l14 14M19 5L5 19',
    palette: 'M12 3a9 9 0 1 0 0 18q3 0 2-3t4-3q4 0 3-5a9 9 0 0 0-9-7M7 8h1M12 6h1M17 9h1M6 13h1',
};
export function icon(id: string): string {
    const path = toolDefinitions.find((t) => t[0] === id)?.[3] || commands[id] || commands.menu;
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
}
