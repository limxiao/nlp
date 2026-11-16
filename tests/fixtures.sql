INSERT INTO sections (id,kind,number,title,position,body,status)
VALUES ('ch-test','chapter','第1章','テスト章',10,'日本語の検証用データです。','verified');
INSERT INTO sections (id,parent_id,kind,number,title,position,body,status,print_from,print_to,source_file,source_from,source_to)
VALUES ('s-test','ch-test','section','1.1','数式と検索',10,'[[page:2]]

検索対象語が本文にあります。式 [1.1](#eq-1.1) を参照。脚注[^7]。

$$
' || char(92) || 'underbrace{a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a}_{' || char(92) || 'text{long equation}}' || char(92) || 'tag{1.1}
$$

| 入力 | 出力 |
| --- | --- |
| A | B |

<script>document.documentElement.dataset.injected="yes"</script>

![外部画像](https://example.invalid/pixel.jpg)

![試験用画像](asset:fig-test)

[^7]: 印刷時の脚注番号。','verified',2,2,'fixture.pdf',2,2);
INSERT INTO sections (id,parent_id,kind,number,title,position,published)
VALUES ('s-empty','ch-test','section','1.2','未収録の節',20,1);
INSERT INTO sections (id,kind,title,position,body,status)
VALUES ('symbols','symbols','記号表',0,'記号 $x$。','verified');
