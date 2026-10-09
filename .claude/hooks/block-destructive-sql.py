#!/usr/bin/env python3
"""Bloqueia SQL destrutivo antes de o Claude executar (Supabase MCP ou psql/prisma no Bash).

Bloqueia: DROP, TRUNCATE, DELETE sem WHERE, UPDATE sem WHERE, ALTER ... DROP.
Saída 2 = bloqueia e devolve o motivo ao Claude; saída 0 = segue para as regras normais.
"""
import json, re, sys

data = json.load(sys.stdin)
tool = data.get("tool_name", "")
inp = data.get("tool_input", {}) or {}

if tool == "Bash":
    sql = inp.get("command", "")
    # Só olha comandos que falam com o banco.
    if not re.search(r"\b(psql|prisma\s+db\s+execute|\$executeRaw|\$queryRaw)\b", sql):
        sys.exit(0)
else:
    sql = inp.get("query", "")

# Remove comentários e literais para não casar palavra dentro de string.
s = re.sub(r"--[^\n]*|/\*.*?\*/", " ", sql, flags=re.S)
s = re.sub(r"'(?:[^']|'')*'", "''", s)

problems = []
if re.search(r"\bdrop\s+(table|schema|database|view|materialized|index|function|type|column|constraint)\b", s, re.I):
    problems.append("DROP")
if re.search(r"\btruncate\b", s, re.I):
    problems.append("TRUNCATE")
for stmt in re.split(r";", s):
    if re.search(r"\bdelete\s+from\b", stmt, re.I) and not re.search(r"\bwhere\b", stmt, re.I):
        problems.append("DELETE sem WHERE")
    if re.search(r"\bupdate\s+\S+\s+set\b", stmt, re.I) and not re.search(r"\bwhere\b", stmt, re.I):
        problems.append("UPDATE sem WHERE")

if problems:
    print(f"SQL destrutivo bloqueado pelo hook do projeto ({', '.join(sorted(set(problems)))}). "
          "Peça ao Joseph para rodar manualmente ou aprovar explicitamente.", file=sys.stderr)
    sys.exit(2)
sys.exit(0)
