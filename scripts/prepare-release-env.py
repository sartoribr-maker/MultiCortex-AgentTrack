#!/usr/bin/env python3
"""Prepare a private candidate env without modifying original credentials."""
import argparse
import os
from pathlib import Path
import re
import sys


def field(lines, name):
    matches=[line for line in lines if line.startswith(name+'=')]
    if len(matches)!=1: raise ValueError('Configuração ausente ou duplicada')
    return matches[0]


def prepare(production, agenttrack, output):
    original=production.read_text().splitlines()
    staging=agenttrack.read_text().splitlines()
    field(original,'AUTH_SECRET'); users=field(original,'DEVCORE_USERS')
    admin=field(staging,'DEVCORE_ADMIN_EMAILS'); bootstrap=field(staging,'DEVCORE_BOOTSTRAP_TOKEN')
    value=bootstrap.split('=',1)[1].strip().strip('\"\x27')
    if not re.fullmatch(r'[a-f0-9]{64}',value): raise ValueError('Bootstrap inválido')
    members={entry.split(':',1)[0].strip().lower() for entry in users.split('=',1)[1].strip().strip('\"\x27').split(',')}
    allowed={entry.strip().lower() for entry in admin.split('=',1)[1].strip().strip('\"\x27').split(',') if entry.strip()}
    if not allowed or not allowed.issubset(members): raise ValueError('Administrador não pertence aos usuários originais')
    overrides={'AUTH_URL','NEXT_PUBLIC_BASE_PATH','DEVCORE_ADMIN_EMAILS','DEVCORE_BOOTSTRAP_TOKEN'}
    lines=[line for line in original if line.split('=',1)[0] not in overrides]
    lines.extend(['AUTH_URL=https://devcore.multicortex.com.br','NEXT_PUBLIC_BASE_PATH=',admin,bootstrap])
    fd=os.open(str(output),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as handle:
        handle.write('\n'.join(lines)+'\n');handle.flush();os.fsync(handle.fileno())


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--production',required=True);p.add_argument('--agenttrack',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    try:
        prepare(Path(a.production),Path(a.agenttrack),Path(a.output));print('Configuração candidata criada com modo 0600; originais preservados; segredos não exibidos')
    except Exception:
        print('Preparação recusada; confira configurações, usuários e destino novo',file=sys.stderr);sys.exit(1)
