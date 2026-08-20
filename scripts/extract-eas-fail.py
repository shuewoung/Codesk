import json
import sys

path = sys.argv[1]
needles = ("FAILURE", "What went wrong", "BUILD FAILED", "ndk", "JPush", "error:", "Execution failed")
with open(path, "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        if '"msg"' not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = str(obj.get("msg", ""))
        phase = str(obj.get("phase", ""))
        if phase == "RUN_GRADLEW" or any(n.lower() in msg.lower() for n in needles):
            if len(msg) > 400:
                msg = msg[:400]
            print(f"[{phase}] {msg}".encode("ascii", "replace").decode("ascii"))
