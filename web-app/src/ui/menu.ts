export const documentMenuGroups = [
    {
        label: '파일',
        commands: [
            ['new', '새 그림 탭', 'plus'],
            ['open', '파일 열기', 'open'],
            ['insert', '현재 그림에 사진 삽입', 'open'],
            ['save', '프로젝트 저장', 'save'],
            ['save-as', '프로젝트 다른 이름 저장', 'save'],
            ['export', '이미지 내보내기', 'export'],
            ['recover', '복구 사본', 'save'],
        ],
    },
    {
        label: '편집',
        commands: [
            ['undo', '실행 취소', 'undo'],
            ['redo', '다시 실행', 'redo'],
            ['copy', '복사', 'select'],
            ['cut', '잘라내기', 'select'],
            ['paste', '붙여넣기', 'select'],
            ['select-all', '전체 선택', 'select'],
            ['delete', '선택 삭제', 'eraser'],
            ['crop', '선택 자르기', 'select'],
            ['selection-size', '선택 크기', 'fit'],
        ],
    },
    {
        label: '이미지',
        commands: [
            ['canvas-size', '캔버스 크기', 'rectangle'],
            ['image-size', '이미지 크기', 'fit'],
            ['rotate-right', '오른쪽 회전', 'redo'],
            ['rotate-left', '왼쪽 회전', 'undo'],
            ['flip-x', '좌우 반전', 'pan'],
            ['flip-y', '상하 반전', 'pan'],
            ['shear', '가로 기울이기', 'polygon'],
            ['invert', '색 반전', 'palette'],
        ],
    },
    {
        label: '레이어',
        commands: [
            ['layer-add', '레이어 추가', 'plus'],
            ['layer-delete', '레이어 삭제', 'minus'],
            ['layer-up', '위로 이동', 'layers'],
            ['layer-down', '아래로 이동', 'layers'],
            ['layer-merge', '아래와 병합', 'layers'],
            ['layer-rename', '이름 변경', 'text'],
            ['clear', '활성 레이어 지우기', 'eraser'],
        ],
    },
    {
        label: '설정',
        commands: [
            ['settings', '테마 · 환경설정', 'settings'],
            ['text-options', '글꼴 · 문자 설정', 'text'],
            ['background', '문서 지우기 바탕', 'palette'],
        ],
    },
    { label: '도움말', commands: [['help', '사용 방법', 'menu']] },
];
