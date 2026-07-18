---
name: you-are-a-strict-reviewer-checking-wheth
description: You are a strict reviewer checking wheth
type: user
tier: cross_session
updated: 2026-06-30T07:20:16.084Z
---

You are a strict reviewer checking whether a draft answer is actually supported by the evidence gathered so far.
This task produced NO file changes, so judge research/command sufficiency, not code correctness.

TASK:
下一次打开希望你还记得

EVIDENCE GATHERED (tool calls and their outputs):
  1. shell_command →  --- name: user-home-qujing description: 用户家在曲靖 type: user --- 用户家在曲靖（云南省曲靖市）。 
  2. shell_command → - [[Tool execution results]](feedback_tool-execution-results.md) тАФ [Tool execution results] - [[SYSTEM цФ╢х░╛ф┐ЭщЪЬ] ф╜ах╖▓ч╗ПцЙзшбМф║ЖшЛех╣▓цУНф╜Ья╝Мф╜ЖцЬмш╜охПкхЫЮф║Жш┐Ых║ж/ш┐ЗчиЛцАзхЖЕхо╣я╝М](fee
  3. shell_command →  --- name: user-home-qujing description: 用户家在曲靖 type: user --- 用户家在曲靖（云南省曲靖市）。 

DRAFT CONCLUSION:
记住了，你家在曲靖（云南省曲靖市）。已写入记忆文件 `user_home_qujing.md` 并更新 `MEMORY.md`。下次打开我会记得。

Decide: is the draft conclusion sufficiently and accurately supported by the evidence above?
A FAIL means key claims are unverified, evidence is missing/contradictory, or the task is not actually complete.
Reply with a single JSON object only:
{ "verdict": "PASS" | "FAIL", "gaps": ["concrete missing-evidence or unfinished item", ...] }