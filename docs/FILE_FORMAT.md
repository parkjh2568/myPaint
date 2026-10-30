# RPAINT01 파일 형식

네트워크·스크립트·실행 파일을 포함하지 않는 자체 이진 문서 형식입니다. 컨테이너는 ZIP이 아니며, 파일 순서대로 읽습니다. 모든 다중 바이트 정수는 unsigned little-endian입니다.

| 필드 | 크기 | 의미 |
| --- | --- | --- |
| magic | 8바이트 | ASCII `RPAINT01` |
| width, height | 각 uint32 | 모든 레이어가 공유하는 문서 크기 |
| layerCount | uint32 | 1~16 |
| activeLayer | uint32 | 0부터 시작하는 활성 레이어 |
| background | uint32 | QRgb `0xAARRGGBB` |

이후 아래 레코드를 `layerCount`번 반복합니다. 순서는 아래 레이어부터 위 레이어입니다.

| 필드 | 크기 | 의미 |
| --- | --- | --- |
| nameLength | uint32 | UTF-8 이름 바이트 수, 최대 1,024 |
| name | nameLength바이트 | UTF-8 이름, 디코딩한 QString 길이 최대 256 |
| visible | uint8 | 0 또는 1 |
| pngLength | uint32 | PNG 데이터 바이트 수, 1~140 MiB |
| png | pngLength바이트 | 문서와 정확히 같은 크기의 PNG |

마지막 레코드 이후 추가 데이터는 허용하지 않습니다. 문서 크기와 픽셀/레이어 합계는 ARCHITECTURE.md의 한도를 따릅니다. 파일 전체는 300 MiB 이하입니다. 내부 PNG 크기 확인과 디코딩 할당 제한을 모두 적용합니다.

픽셀과 레이어는 보존하지만 Undo 이력, UI 확대율, 브러시 설정, 미확정 텍스트·선택은 저장하지 않습니다. 텍스트는 확정할 때 래스터화됩니다. 읽기는 후보 문서를 완성한 후에만 기존 문서를 교체합니다.

현재 공개 버전은 `RPAINT01` 하나입니다. 이후 호환되지 않는 필드를 추가한다면 magic 버전을 바꾸고 마이그레이션을 별도로 구현해야 합니다. 기존 레코드 중간에 필드를 추가해서는 안 됩니다.
