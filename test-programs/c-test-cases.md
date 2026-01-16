# C言語テストケース集

本プロジェクト（TypedCode）のWasmer + Clang実行環境で検証すべきテストケースです。

## 1. 正常系テスト

### 1.1 基本的なHello World
```c
#include <stdio.h>

int main() {
    printf("Hello, World!\n");
    return 0;
}
```

### 1.2 標準入力テスト（対話的入力）
```c
#include <stdio.h>

int main() {
    char name[100];
    printf("名前を入力してください: ");
    scanf("%99s", name);
    printf("こんにちは、%sさん！\n", name);
    return 0;
}
```

### 1.3 複数行入力テスト
```c
#include <stdio.h>

int main() {
    int a, b;
    printf("2つの整数を入力してください:\n");
    scanf("%d", &a);
    scanf("%d", &b);
    printf("合計: %d\n", a + b);
    printf("積: %d\n", a * b);
    return 0;
}
```

---

## 2. コンパイルエラーテスト

### 2.1 構文エラー（セミコロン欠落）
```c
#include <stdio.h>

int main() {
    printf("Hello")  // セミコロンなし
    return 0;
}
```

### 2.2 未宣言変数
```c
#include <stdio.h>

int main() {
    printf("%d\n", x);  // xは未宣言
    return 0;
}
```

### 2.3 型エラー
```c
#include <stdio.h>

int main() {
    int *p = "hello";  // 型不一致
    printf("%d\n", p);
    return 0;
}
```

### 2.4 関数宣言エラー
```c
#include <stdio.h>

int main() {
    int result = add(1, 2);  // add関数は未定義
    printf("%d\n", result);
    return 0;
}
```

### 2.5 ヘッダーファイル不足
```c
int main() {
    printf("Hello\n");  // stdio.hがない
    return 0;
}
```

---

## 3. ランタイムエラーテスト（クラッシュ系）

### 3.1 配列境界外アクセス
```c
#include <stdio.h>

int main() {
    int arr[5] = {1, 2, 3, 4, 5};
    printf("%d\n", arr[1000]);  // 境界外アクセス
    return 0;
}
```

### 3.2 ゼロ除算
```c
#include <stdio.h>

int main() {
    int a = 10;
    int b = 0;
    int c = a / b;  // ゼロ除算
    printf("%d\n", c);
    return 0;
}
```

### 3.3 NULLポインタ参照
```c
#include <stdio.h>

int main() {
    int *p = NULL;
    printf("%d\n", *p);  // NULLデリファレンス
    return 0;
}
```

### 3.4 スタックオーバーフロー（無限再帰）
```c
#include <stdio.h>

void infinite_recursion(int n) {
    printf("Depth: %d\n", n);
    infinite_recursion(n + 1);  // 無限再帰
}

int main() {
    infinite_recursion(0);
    return 0;
}
```

### 3.5 大量メモリ確保
```c
#include <stdio.h>
#include <stdlib.h>

int main() {
    // 1GB確保を試みる
    void *p = malloc(1024 * 1024 * 1024);
    if (p == NULL) {
        printf("メモリ確保失敗\n");
    } else {
        printf("メモリ確保成功: %p\n", p);
        free(p);
    }
    return 0;
}
```

---

## 4. 無限ループ・長時間実行テスト

### 4.1 無限ループ（停止テスト用）
```c
#include <stdio.h>

int main() {
    int i = 0;
    while (1) {
        if (i % 1000000 == 0) {
            printf("Count: %d\n", i);
            fflush(stdout);
        }
        i++;
    }
    return 0;
}
```

### 4.2 CPU負荷テスト
```c
#include <stdio.h>

int main() {
    long long sum = 0;
    for (long long i = 0; i < 1000000000LL; i++) {
        sum += i;
    }
    printf("Sum: %lld\n", sum);
    return 0;
}
```

---

## 5. 入出力エッジケース

### 5.1 大量出力
```c
#include <stdio.h>

int main() {
    for (int i = 0; i < 10000; i++) {
        printf("Line %d: This is a test line with some content.\n", i);
    }
    return 0;
}
```

### 5.2 バイナリ出力（非表示文字）
```c
#include <stdio.h>

int main() {
    // 制御文字を含む出力
    printf("Normal\t");
    printf("Tab\t");
    printf("Bell\a");
    printf("Backspace\b");
    printf("\nCarriage Return\rOverwrite");
    printf("\nDone\n");
    return 0;
}
```

### 5.3 日本語出力
```c
#include <stdio.h>

int main() {
    printf("こんにちは、世界！\n");
    printf("日本語テスト: あいうえお\n");
    printf("漢字: 東京都\n");
    return 0;
}
```

### 5.4 空の入力待ち
```c
#include <stdio.h>

int main() {
    char c;
    printf("何かキーを押してください: ");
    fflush(stdout);
    c = getchar();
    printf("入力された文字: '%c' (ASCII: %d)\n", c, c);
    return 0;
}
```

---

## 6. メモリ操作テスト

### 6.1 動的メモリ確保
```c
#include <stdio.h>
#include <stdlib.h>

int main() {
    int *arr = (int *)malloc(10 * sizeof(int));
    if (arr == NULL) {
        printf("malloc failed\n");
        return 1;
    }

    for (int i = 0; i < 10; i++) {
        arr[i] = i * i;
    }

    for (int i = 0; i < 10; i++) {
        printf("arr[%d] = %d\n", i, arr[i]);
    }

    free(arr);
    printf("Memory freed successfully\n");
    return 0;
}
```

### 6.2 realloc テスト
```c
#include <stdio.h>
#include <stdlib.h>

int main() {
    int *arr = (int *)malloc(5 * sizeof(int));
    for (int i = 0; i < 5; i++) arr[i] = i;

    printf("Before realloc:\n");
    for (int i = 0; i < 5; i++) printf("%d ", arr[i]);
    printf("\n");

    arr = (int *)realloc(arr, 10 * sizeof(int));
    for (int i = 5; i < 10; i++) arr[i] = i * 2;

    printf("After realloc:\n");
    for (int i = 0; i < 10; i++) printf("%d ", arr[i]);
    printf("\n");

    free(arr);
    return 0;
}
```

### 6.3 Use After Free（未定義動作）
```c
#include <stdio.h>
#include <stdlib.h>

int main() {
    int *p = (int *)malloc(sizeof(int));
    *p = 42;
    printf("Before free: %d\n", *p);
    free(p);
    printf("After free: %d\n", *p);  // 未定義動作
    return 0;
}
```

### 6.4 Double Free（クラッシュ可能性）
```c
#include <stdio.h>
#include <stdlib.h>

int main() {
    int *p = (int *)malloc(sizeof(int));
    *p = 100;
    free(p);
    free(p);  // Double free
    printf("Done\n");
    return 0;
}
```

---

## 7. 数値演算エッジケース

### 7.1 整数オーバーフロー
```c
#include <stdio.h>
#include <limits.h>

int main() {
    int max = INT_MAX;
    printf("INT_MAX: %d\n", max);
    printf("INT_MAX + 1: %d\n", max + 1);  // オーバーフロー
    return 0;
}
```

### 7.2 浮動小数点演算
```c
#include <stdio.h>
#include <math.h>

int main() {
    double a = 0.1 + 0.2;
    printf("0.1 + 0.2 = %.17f\n", a);

    double inf = 1.0 / 0.0;
    printf("1.0 / 0.0 = %f\n", inf);

    double nan = 0.0 / 0.0;
    printf("0.0 / 0.0 = %f\n", nan);

    return 0;
}
```

---

## 8. 構造体・ポインタテスト

### 8.1 構造体の使用
```c
#include <stdio.h>

typedef struct {
    char name[50];
    int age;
    float score;
} Student;

int main() {
    Student s = {"Taro", 20, 85.5};
    printf("Name: %s\n", s.name);
    printf("Age: %d\n", s.age);
    printf("Score: %.1f\n", s.score);
    return 0;
}
```

### 8.2 ポインタ演算
```c
#include <stdio.h>

int main() {
    int arr[] = {10, 20, 30, 40, 50};
    int *p = arr;

    printf("Using array index:\n");
    for (int i = 0; i < 5; i++) {
        printf("arr[%d] = %d\n", i, arr[i]);
    }

    printf("\nUsing pointer arithmetic:\n");
    for (int i = 0; i < 5; i++) {
        printf("*(p + %d) = %d\n", i, *(p + i));
    }

    return 0;
}
```

---

## 9. 警告が出るコード

### 9.1 未使用変数
```c
#include <stdio.h>

int main() {
    int unused_var = 42;  // 未使用
    printf("Hello\n");
    return 0;
}
```

### 9.2 暗黙の型変換
```c
#include <stdio.h>

int main() {
    double d = 3.14159;
    int i = d;  // 精度損失の警告
    printf("double: %f, int: %d\n", d, i);
    return 0;
}
```

### 9.3 フォーマット指定子の不一致
```c
#include <stdio.h>

int main() {
    long long big = 9223372036854775807LL;
    printf("Value: %d\n", big);  // %lldであるべき
    return 0;
}
```

---

## 10. WASI特有のテスト

### 10.1 環境変数アクセス（制限あり）
```c
#include <stdio.h>
#include <stdlib.h>

int main() {
    char *path = getenv("PATH");
    if (path) {
        printf("PATH: %s\n", path);
    } else {
        printf("PATH is not set\n");
    }
    return 0;
}
```

### 10.2 時刻取得
```c
#include <stdio.h>
#include <time.h>

int main() {
    time_t now = time(NULL);
    printf("Current time: %ld\n", now);

    struct tm *local = localtime(&now);
    if (local) {
        printf("Year: %d\n", local->tm_year + 1900);
        printf("Month: %d\n", local->tm_mon + 1);
        printf("Day: %d\n", local->tm_mday);
    }
    return 0;
}
```

### 10.3 乱数生成
```c
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main() {
    srand(time(NULL));

    printf("Random numbers:\n");
    for (int i = 0; i < 10; i++) {
        printf("%d ", rand() % 100);
    }
    printf("\n");
    return 0;
}
```

---

## 検証観点

各テストケースで以下を確認：

1. **コンパイル結果**: 成功/失敗、エラーメッセージの表示
2. **実行結果**: 正常終了/クラッシュ、終了コード
3. **エラー表示**: 行番号・カラム番号の正確性
4. **ターミナル表示**: stdout/stderrの色分け
5. **入力処理**: stdinの正常動作
6. **ランタイム復帰**: クラッシュ後の自動リセット動作
7. **UIの応答性**: 長時間実行中のブロック有無
