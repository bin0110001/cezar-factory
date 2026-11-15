#!/usr/bin/env python3
"""Generic non-Godot GUI fixture: opens a solid-colour X window and idles."""
import sys, time, tkinter

root = tkinter.Tk()
root.title("graphical-session-fixture")
root.geometry("320x200+0+0")
tkinter.Label(root, text="graphical session fixture", bg="#2255aa", fg="white").pack(fill="both", expand=True)
root.update()
print("fixture-ready", flush=True)
deadline = time.time() + float(sys.argv[1] if len(sys.argv) > 1 else 60)
while time.time() < deadline:
    root.update()
    time.sleep(0.05)
