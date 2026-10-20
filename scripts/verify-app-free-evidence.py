#!/usr/bin/env python3
"""Read-only exact-candidate gate; combines existing gates with new same-source cases."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import runpy
from urllib.parse import quote
from urllib.request import urlopen
import zipfile

legacy = runpy.run_path(str(Path(__file__).with_name('verify-release-evidence.py')))
api = legacy['api_json']
pages = legacy['pages']
api_bytes = legacy['api_bytes']
require = legacy['require']


def read_artifact(data):
    require(len(data) <= 1024 * 1024, 'artifact exceeds size budget')
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        entries = bundle.infolist()
        require(len(entries) == 1 and entries[0].filename == 'app-free-acceptance.json', 'unexpected evidence artifact contents')
        require(entries[0].file_size <= 100 * 1024, 'evidence JSON too large')
        with bundle.open(entries[0]) as stream:
            data = stream.read(100 * 1024 + 1)
        require(len(data) <= 100 * 1024, 'evidence JSON exceeds decompression budget')
        return json.loads(data)


def verify_evidence(run, evidence, kind, actions_sha, npm_sha, deliveries=True):
    fixture = 'releaseway/release-fixture' if kind == 'git' else 'releaseway/npm-actions-fixture'
    workflow = 'app-free-acceptance.yml' if kind == 'git' else 'direct.yml'
    legacy['successful_run'](run, fixture, run['head_sha'], workflow)
    require(run['event'] == 'workflow_dispatch', 'acceptance event mismatch')
    require(evidence.get('schema') == 1 and evidence.get('scenario') == 'app-free-' + kind, 'evidence schema/scenario mismatch')
    expected = {'actions': actions_sha, **({'npm': npm_sha} if kind == 'npm' else {})}
    require(evidence.get('candidates') == expected, 'exact candidates mismatch')
    require(evidence.get('fixture_repository') == fixture and evidence.get('fixture_commit') == run['head_sha'], 'fixture source mismatch')
    require(evidence.get('branch_commit') == run['head_sha'], 'source branch was not preserved')
    require(evidence.get('workflow') == workflow and evidence.get('run_id') == run['id'] and evidence.get('run_attempt') == run['run_attempt'], 'current workflow/run/attempt mismatch')
    channels = evidence.get('channels', {})
    require(set(channels) == {'rc', 'stable'}, 'both channels required')
    for channel, result in channels.items():
        version = result.get('version', '')
        require(re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?' if channel == 'rc' else r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version), 'invalid channel version')
        require(('-rc.' in version) == (channel == 'rc'), 'rc must be prerelease')
        require(result.get('tag') == 'app-free-v' + version and result.get('commit') == run['head_sha'], 'channel tag/source mismatch')
        require(re.fullmatch(r'[0-9a-f]{40}', result.get('tag_object', '')), 'annotated tag object missing')
        require(result.get('asset_sha256') == hashlib.sha256((version + '\n').encode()).hexdigest(), 'asset version digest mismatch')
        if kind == 'npm':
            integrity = result.get('integrity', '')
            require(re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', integrity) and len(base64.b64decode(integrity[7:], validate=True)) == 64, 'npm integrity missing')
    require(channels['rc']['version'].split('-')[0] == channels['stable']['version'], 'promotion core differs')
    if kind == 'npm':
        require(evidence.get('installed_node_versions') == ['22', '24', '26'], 'native consumer matrix incomplete')
    if kind == 'git' and deliveries:
        tap, site = evidence.get('homebrew'), evidence.get('pages')
        require(isinstance(tap, dict) and tap.get('repository') == 'releaseway/homebrew-tap-fixture' and tap.get('formula') == 'release-fixture-app-free' and re.fullmatch(r'[0-9a-f]{40}', tap.get('commit', '')), 'tap evidence missing')
        require(isinstance(site, dict) and site.get('url', '').startswith('https://releaseway.github.io/') and type(site.get('deployment_id')) is int and site['deployment_id'] > 0, 'Pages deployment missing')
        require(re.fullmatch(r'[0-9a-f]{64}', site.get('content_digest', '')) and site.get('served_sha256') == channels['stable']['asset_sha256'], 'served Pages identity mismatch')
    return evidence


def verify_remote(evidence, kind):
    fixture, source = evidence['fixture_repository'], evidence['fixture_commit']
    for channel, result in evidence['channels'].items():
        tag = result['tag']
        ref = api(f'repos/{fixture}/git/ref/tags/{quote(tag, safe="")}')['object']
        require(ref['type'] == 'tag' and ref['sha'] == result['tag_object'], 'remote tag object changed')
        obj = api(f'repos/{fixture}/git/tags/{ref["sha"]}')
        require(obj['object'].get('type') == 'commit' and obj['object'].get('sha') == source, 'remote tag source changed')
        message = obj['message']
        require(message.startswith('Releaseway-Source-Tag: 1\n\n'), 'tag identity marker missing')
        annotation = json.loads(message.split('\n\n', 1)[1])
        require(set(annotation) == {'schema', 'strategy', 'source', 'config', 'policyDigest', 'prereleaseId', 'tag', 'version'} and annotation['schema'] == 1 and annotation['strategy'] == 'source-tag' and annotation['prereleaseId'] == ('rc' if channel == 'rc' else ''), 'remote annotation schema/channel mismatch')
        require(annotation.get('source') == source and annotation.get('tag') == tag and annotation.get('version') == result['version'], 'remote annotation identity mismatch')
        config = annotation['config']
        require(set(config) == {'schema', 'strategy', 'branch', 'tagPrefix', 'initialVersion', 'bump', 'series', 'latest'} and config['schema'] == 1 and config['strategy'] == 'source-tag' and config['branch'] == 'main' and config['tagPrefix'] == 'app-free-v' and config['series'] is None and config['latest'] == 'false', 'remote fixture policy mismatch')
        canonical = {key: config[key] for key in ['schema', 'strategy', 'branch', 'tagPrefix', 'initialVersion', 'bump', 'series', 'latest']}
        require(annotation.get('policyDigest') == hashlib.sha256(json.dumps(canonical, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest(), 'remote policy digest mismatch')
        release = api(f'repos/{fixture}/releases/tags/{quote(tag, safe="")}')
        require(release['tag_name'] == tag and release['draft'] is False and release.get('immutable') is True and release['prerelease'] is (channel == 'rc'), 'public immutable Release mismatch')
        if kind == 'npm':
            with urlopen('https://registry.npmjs.org/@releaseway%2fnpm-actions-fixture/' + quote(result['version'], safe=''), timeout=60) as response:
                manifest = json.load(response)
            require(manifest['version'] == result['version'] and result['integrity'] in manifest['dist']['integrity'].split(), 'live npm bytes mismatch')
    if kind == 'git':
        tap = evidence['homebrew']
        file = api(f'repos/{tap["repository"]}/contents/Formula/{tap["formula"]}.rb?ref={tap["commit"]}')
        require(file.get('encoding') == 'base64' and file.get('size', 0) <= 100 * 1024, 'tap Formula metadata invalid')
        formula = base64.b64decode(''.join(file['content'].split()), validate=True).decode()
        require('# releaseway-source-commit: ' + source in formula and '# releaseway-version: ' + evidence['channels']['stable']['version'] in formula, 'tap source/version mismatch')
        site = evidence['pages']
        deployment = api(f'repos/{fixture}/deployments/{site["deployment_id"]}')
        require(deployment.get('sha') == source and deployment.get('environment') == 'github-pages', 'Pages deployment source mismatch')
        with urlopen(site['url'].rstrip('/') + '/version.txt', timeout=60) as response:
            data = response.read(4096)
        require(hashlib.sha256(data).hexdigest() == site['served_sha256'], 'live Pages bytes mismatch')


def verify_run(kind, run_id, actions_sha, npm_sha):
    require(isinstance(run_id, int) and run_id > 0, 'positive acceptance run ID required')
    fixture = 'releaseway/release-fixture' if kind == 'git' else 'releaseway/npm-actions-fixture'
    run = api(f'repos/{fixture}/actions/runs/{run_id}')
    artifacts = [item for item in pages(f'repos/{fixture}/actions/runs/{run_id}/artifacts', 'artifacts') if item['name'] == f'app-free-acceptance-{run["run_attempt"]}']
    require(len(artifacts) == 1 and not artifacts[0]['expired'] and artifacts[0]['size_in_bytes'] <= 1024 * 1024, 'current-attempt evidence missing/ambiguous')
    evidence = read_artifact(api_bytes(f'repos/{fixture}/actions/artifacts/{artifacts[0]["id"]}/zip'))
    verify_evidence(run, evidence, kind, actions_sha, npm_sha)
    verify_remote(evidence, kind)
    return {'kind': kind, 'run_id': run_id, 'run_attempt': run['run_attempt'], 'fixture_commit': run['head_sha']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ['actions-sha', 'npm-sha']:
        parser.add_argument('--' + arg, required=True)
    for arg in ['git-run', 'npm-run', 'notes-run', 'stage-run', 'legacy-native-run']:
        parser.add_argument('--' + arg, required=True, type=int)
    args = parser.parse_args()
    for sha in [args.actions_sha, args.npm_sha]:
        require(re.fullmatch(r'[0-9a-f]{40}', sha), 'full lowercase candidate SHA required')
    legacy['verify']('releaseway/actions', args.actions_sha, [args.notes_run])
    legacy['verify']('releaseway/npm-actions', args.npm_sha, [args.stage_run, args.legacy_native_run])
    results = [verify_run('git', args.git_run, args.actions_sha, args.npm_sha), verify_run('npm', args.npm_run, args.actions_sha, args.npm_sha)]
    print(json.dumps({'verified': True, 'actions_sha': args.actions_sha, 'npm_sha': args.npm_sha, 'runs': results}))
