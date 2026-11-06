#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MultiCortex Universal Agent - Metrics endpoint discovery.

Python 3.6+; standard library only.
Performs a bounded availability check, not metrics collection.
"""

import json
import urllib.error
import urllib.request


def check_metrics(port, api_key=None, timeout=3):
    try:
        port = int(port)
        if not 1 <= port <= 65535:
            raise ValueError()
    except (TypeError, ValueError):
        return {"status": "invalid_port", "http_code": None}

    url = "http://127.0.0.1:{}/metrics".format(port)

    headers = {}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key

    request = urllib.request.Request(url, headers=headers)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            code = response.getcode()
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
    except (urllib.error.URLError, OSError, ValueError):
        return {"status": "unreachable", "http_code": None}

    statuses = {
        200: "available",
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
        501: "disabled_or_not_implemented",
    }

    return {
        "status": statuses.get(code, "unexpected_response"),
        "http_code": code,
    }


if __name__ == "__main__":
    print(json.dumps(
        check_metrics(7080),
        indent=2,
        sort_keys=True
    ))
