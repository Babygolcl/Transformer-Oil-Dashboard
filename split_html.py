import io

with io.open('D:/AI Data/Transformer Oil Analysis AntiGravity/Output/index.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = lines[:5] + ['<link rel="stylesheet" href="style.css">\n'] + lines[194:1076] + ['<script src="app.js"></script>\n'] + lines[2215:]

with io.open('D:/AI Data/Transformer Oil Analysis AntiGravity/Output/index.html', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)
