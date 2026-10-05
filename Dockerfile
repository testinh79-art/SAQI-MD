FROM node:22-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install

# SAQI-MD PATCH: libsignal har decrypt-fail par console.error + POORA stack trace likhta hy.
# Bad MAC flood ke waqt ye sैकڑوں synchronous stdout writes banata hy aur event loop block
# kar deta hy — bot ke asli jawab 40+ second peeche reh jate hain. Errors pehle hi exception
# ki tarah propagate hoti hain, is liye silence karna behavior nahi badalta.
RUN node -e "const fs=require('fs');const p='node_modules/libsignal/src/session_cipher.js';let s=fs.readFileSync(p,'utf8');const o='        console.error(\"Failed to decrypt message with any known session...\");\n        for (const e of errs) {\n            console.error(\"Session error:\" + e, e.stack);\n        }';const n='        if (process.env.SAQI_VERBOSE_SIGNAL === \'1\') {\n          console.error(\"Failed to decrypt message with any known session...\");\n          for (const e of errs) { console.error(\"Session error:\" + e, e.stack); }\n        }';if(!s.includes(o)){console.error('PATCH-TARGET-MISSING');process.exit(1);}fs.writeFileSync(p,s.replace(o,n));console.log('libsignal patched');"

COPY . .
EXPOSE 3000
CMD ["node", "worker.js"]
