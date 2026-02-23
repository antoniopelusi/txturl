function mdRender(el) {
    const classMap = [
        [/^###### /, "md-h6"],
        [/^##### /, "md-h5"],
        [/^#### /, "md-h4"],
        [/^### /, "md-h3"],
        [/^## /, "md-h2"],
        [/^# /, "md-h1"],
        [/^> /, "md-quote"],
        [/^[-*] /, "md-li"],
        [/^\d+\. /, "md-oli"],
        [/^-{3,}$/, "md-hr"],
    ];

    let inCode = false;
    for (const div of el.children) {
        const line = div.textContent;
        if (/^`{3}/.test(line)) {
            inCode = !inCode;
            if (div.className !== "md-code") div.className = "md-code";
            continue;
        }
        if (inCode) {
            if (div.className !== "md-code") div.className = "md-code";
            continue;
        }
        const cls = classMap.find(([re]) => re.test(line))?.[1] ?? "md-p";
        if (div.className !== cls) div.className = cls;
    }
}
