#!/usr/bin/env python3
"""Private, verifiable backup/restore. Restore only into a new empty directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import zipfile

TOP = {'.env.agenttrack', '.env.production', '.env.release', 'docker-compose.agenttrack.yml', 'docker-compose.prod.yml', 'docker-compose.release.yml'}
MAX_FILE = 16 * 1024 * 1024


def allowed(name):
    parts = Path(name).parts
    return (not name.startswith('/') and '..' not in parts and '\\' not in name
            and (name in TOP or (len(parts) >= 2 and parts[0] == 'state' and name.endswith('.json'))))


def inventory(root):
    files = [root / name for name in TOP if (root/name).exists()]
    state = root/'state'
    if state.exists():
        for parent, directories, names in os.walk(str(state), followlinks=False):
            for name in directories:
                if (Path(parent)/name).is_symlink():
                    raise ValueError('Symlink no estado')
            if any(name.endswith('.lock') for name in names):
                raise ValueError('Estado ocupado; pare o aplicativo antes do backup')
            files.extend(Path(parent)/name for name in names if name.endswith('.json'))
    if not files:
        raise ValueError('Nenhum dado para backup')
    for path in files:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE:
            raise ValueError('Arquivo não permitido')
    return sorted(files)


def backup(root, destination, quiesced=False):
    if not quiesced:
        raise ValueError('Confirme aplicativo parado com --quiesced')
    if destination.exists():
        raise ValueError('Backup já existe; não será sobrescrito')
    files = inventory(root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.backup-', dir=str(destination.parent))
    os.close(fd)
    manifest = {}
    try:
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in files:
                name = path.relative_to(root).as_posix()
                if not allowed(name): raise ValueError('Caminho não permitido')
                data = path.read_bytes()
                manifest[name] = hashlib.sha256(data).hexdigest()
                archive.writestr(name, data)
            archive.writestr('BACKUP-MANIFEST.json', json.dumps({'version': 1, 'sha256': manifest}, sort_keys=True))
        for path in files:
            if hashlib.sha256(path.read_bytes()).hexdigest() != manifest[path.relative_to(root).as_posix()]:
                raise ValueError('Estado mudou durante backup; pare o aplicativo')
        with open(temporary,'rb') as handle: os.fsync(handle.fileno())
        os.link(temporary, str(destination))
    finally:
        os.unlink(temporary)
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def verify(archive_path):
    with zipfile.ZipFile(str(archive_path)) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or len(names) > 100000:
            raise ValueError('Entradas inválidas')
        metadata = archive.getinfo('BACKUP-MANIFEST.json')
        if metadata.file_size > MAX_FILE: raise ValueError('Manifesto excessivo')
        manifest = json.loads(archive.read(metadata))
        if manifest.get('version') != 1 or set(names) != set(manifest['sha256']) | {'BACKUP-MANIFEST.json'}:
            raise ValueError('Manifesto inválido')
        for name, digest in manifest['sha256'].items():
            info = archive.getinfo(name)
            if not allowed(name) or info.file_size > MAX_FILE or (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Entrada não permitida')
            if hashlib.sha256(archive.read(name)).hexdigest() != digest:
                raise ValueError('Integridade inválida')
    return manifest


def restore(archive_path, destination):
    manifest = verify(archive_path)
    if destination.exists(): raise ValueError('Restaurar somente em destino novo')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.restore-', dir=str(destination.parent)))
    try:
        with zipfile.ZipFile(str(archive_path)) as archive:
            for name in manifest['sha256']:
                path = temporary / name
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                fd = os.open(str(path), os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
                with os.fdopen(fd,'wb') as handle: handle.write(archive.read(name))
        os.rename(str(temporary), str(destination))
    finally:
        if temporary.exists():
            import shutil
            shutil.rmtree(str(temporary))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command')
    b = sub.add_parser('backup'); b.add_argument('--root', required=True); b.add_argument('--output', required=True); b.add_argument('--quiesced', action='store_true')
    v = sub.add_parser('verify'); v.add_argument('archive')
    r = sub.add_parser('restore'); r.add_argument('archive'); r.add_argument('--destination', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == 'backup':
        digest = backup(Path(args.root).resolve(), Path(args.output).resolve(), args.quiesced)
        print('Backup privado criado; SHA256: '+digest)
    elif args.command == 'verify':
        manifest = verify(Path(args.archive)); print('Integridade aprovada; arquivos: '+str(len(manifest['sha256'])))
    elif args.command == 'restore':
        restore(Path(args.archive),Path(args.destination).absolute()); print('Restauração em destino novo concluída')
    else: parser.error('Escolha backup, verify ou restore')


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Operação recusada: confira estado parado, integridade e destino novo; nenhum segredo exibido',file=sys.stderr)
        sys.exit(1)
