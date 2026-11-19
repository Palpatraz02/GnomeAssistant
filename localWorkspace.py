"""Broker filesystem requests beneath a user-selected directory without following symlinks."""
import hashlib
import json
import os
import secrets
import stat
import sys

LIMIT = 256 * 1024
DIR = os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY


def open_dir(path, root=None):
    fd = os.open("/" if root is None else ".", DIR, dir_fd=root)
    try:
        for part in path.split("/"):
            if not part:
                continue
            if part in (".", ".."):
                raise ValueError("Dot segments are unavailable.")
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_text(fd, name, missing=False):
    try:
        file = os.open(name, os.O_NOFOLLOW | os.O_NONBLOCK | os.O_RDONLY, dir_fd=fd)
    except FileNotFoundError:
        if missing:
            return None
        raise
    with os.fdopen(file, "rb") as stream:
        if not stat.S_ISREG(os.fstat(file).st_mode):
            raise ValueError("Choose a regular text file.")
        contents = stream.read(LIMIT + 1)
    if len(contents) > LIMIT or b"\0" in contents:
        raise ValueError("Choose a UTF-8 text file of up to 256 KiB.")
    return contents.decode("utf-8")


def fingerprint(value):
    return None if value is None else hashlib.sha256(value.encode("utf-8")).hexdigest()


def main(root, request):
    path = request["path"]
    if not isinstance(path, str) or path.startswith("/") or len(path) > 4096:
        raise ValueError("Use a path relative to the shared folder.")
    mode = request["operation"]
    base = open_dir(root)
    try:
        parent, _, leaf = path.rpartition("/")
        if mode == "list":
            fd = open_dir(path, base)
            try:
                results = []
                with os.scandir(fd) as entries:
                    for entry in entries:
                        if entry.is_dir(follow_symlinks=False):
                            results.append({"name": entry.name, "type": "folder"})
                        elif entry.is_file(follow_symlinks=False):
                            results.append({"name": entry.name, "type": "file"})
                        if len(results) >= 200:
                            break
                return sorted(results, key=lambda item: item["name"])
            finally:
                os.close(fd)
        if not leaf or leaf in (".", ".."):
            raise ValueError("Choose a file in the shared folder.")
        fd = open_dir(parent, base)
        try:
            prior = read_text(fd, leaf, missing=mode != "read")
            if mode != "write":
                return {"text": prior, "revision": fingerprint(prior)}
            data = request["text"].encode("utf-8")
            if len(data) > LIMIT or b"\0" in data:
                raise ValueError("Edits must contain UTF-8 text of up to 256 KiB.")
            if fingerprint(prior) != request["revision"]:
                raise ValueError("The file changed since the preview. Review the edit again.")
            previous = os.stat(leaf, dir_fd=fd, follow_symlinks=False) if prior is not None else None
            temporary = ".gnome-assistant-" + secrets.token_hex(16)
            try:
                with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd), "wb") as stream:
                    stream.write(data)
                    if previous:
                        os.fchmod(stream.fileno(), stat.S_IMODE(previous.st_mode) & 0o777)
                if previous is None:
                    os.link(temporary, leaf, src_dir_fd=fd, dst_dir_fd=fd)
                else:
                    os.replace(temporary, leaf, src_dir_fd=fd, dst_dir_fd=fd)
                return {"written": True}
            finally:
                try:
                    os.unlink(temporary, dir_fd=fd)
                except FileNotFoundError:
                    pass
        finally:
            os.close(fd)
    finally:
        os.close(base)


if __name__ == "__main__":
    try:
        print(json.dumps({"result": main(sys.argv[1], json.load(sys.stdin))}))
    except (OSError, ValueError, KeyError, TypeError, UnicodeError) as error:
        print(json.dumps({"error": str(error)}))
