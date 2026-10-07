#!/usr/bin/env node
import "./ensure-vm-modules.mjs";
import { runApp } from "../dist/index.js";

process.exitCode = await runApp();
