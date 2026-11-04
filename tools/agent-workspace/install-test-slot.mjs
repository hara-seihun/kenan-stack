#!/usr/bin/env node
// Reserve the fixture slot before publication takes exclusive host admission.
// The parent retains its kernel-held descriptor while the installer and its
// rollback tests run. Waiting for a slot cannot strand ordinary workspace calls.
import './test-slot.mjs';
import {spawn} from 'node:child_process';
const [script,...args]=process.argv.slice(2);
const child=spawn('/bin/bash',[script,...args,'test-slot-held'],{stdio:'inherit',env:process.env});
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??1; if(signal)console.error(`installer ended on ${signal}`);});
