import base64
import copy
import hashlib
import io
from pathlib import Path
import runpy
import unittest
import zipfile

checker = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/verify-app-free-evidence.py'))


def fixture(kind):
    repo = 'releaseway/release-fixture' if kind == 'git' else 'releaseway/npm-actions-fixture'
    workflow = 'app-free-acceptance.yml' if kind == 'git' else 'direct.yml'
    sha = 'f' * 40
    run = dict(id=42, run_attempt=2, event='workflow_dispatch', repository={'full_name': repo}, head_sha=sha, path='.github/workflows/' + workflow, status='completed', conclusion='success')
    channels = {}
    for channel, version in [('rc', '0.0.100-rc.0'), ('stable', '0.0.100')]:
        channels[channel] = dict(tag='app-free-v' + version, version=version, commit=sha, tag_object='c' * 40, asset_sha256=hashlib.sha256((version + '\n').encode()).hexdigest())
        if kind == 'npm': channels[channel]['integrity'] = 'sha512-' + base64.b64encode(b'x' * 64).decode()
    evidence = dict(schema=1, scenario='app-free-' + kind, candidates={'actions': 'a' * 40, **({'npm': 'b' * 40} if kind == 'npm' else {})}, fixture_repository=repo, fixture_commit=sha, branch_commit=sha, run_id=42, run_attempt=2, workflow=workflow, channels=channels)
    if kind == 'npm': evidence['installed_node_versions'] = ['22', '24', '26']
    else:
        evidence['homebrew'] = dict(repository='releaseway/homebrew-tap-fixture', formula='release-fixture-app-free', commit='d' * 40)
        evidence['pages'] = dict(url='https://releaseway.github.io/release-fixture/', deployment_id=123, content_digest='e' * 64, served_sha256=channels['stable']['asset_sha256'])
    return run, evidence


class EvidenceTests(unittest.TestCase):
    def test_complete_git_and_npm_are_accepted(self):
        for kind in ['git', 'npm']:
            run, evidence = fixture(kind)
            self.assertEqual(checker['verify_evidence'](run, evidence, kind, 'a' * 40, 'b' * 40), evidence)

    def test_stale_candidate_source_attempt_or_incomplete_delivery_is_rejected(self):
        for kind in ['git', 'npm']:
            run, original = fixture(kind)
            for key, value in [('candidates', {}), ('fixture_commit', '0' * 40), ('branch_commit', '0' * 40), ('run_attempt', 1), ('workflow', 'other.yml'), ('channels', {})]:
                evidence = copy.deepcopy(original); evidence[key] = value
                with self.subTest(kind=kind, key=key):
                    with self.assertRaises(ValueError): checker['verify_evidence'](run, evidence, kind, 'a' * 40, 'b' * 40)
            evidence = copy.deepcopy(original)
            if kind == 'npm': evidence['installed_node_versions'] = ['22', '24']
            else: evidence['pages'] = None
            with self.assertRaises(ValueError): checker['verify_evidence'](run, evidence, kind, 'a' * 40, 'b' * 40)

    def test_unverified_channel_version_or_bytes_are_rejected(self):
        for kind in ['git', 'npm']:
            run, original = fixture(kind)
            for key, value in [('commit', '0' * 40), ('tag_object', ''), ('asset_sha256', '0' * 64), ('version', '0.0.100')]:
                evidence = copy.deepcopy(original); evidence['channels']['rc'][key] = value
                with self.assertRaises(ValueError): checker['verify_evidence'](run, evidence, kind, 'a' * 40, 'b' * 40)

    def test_artifact_filename_and_size_are_bounded(self):
        for name, data in [('other.json', b'{}'), ('app-free-acceptance.json', b'x' * (100 * 1024 + 1))]:
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, 'w') as archive: archive.writestr(name, data)
            with self.assertRaises(ValueError): checker['read_artifact'](stream.getvalue())


if __name__ == '__main__': unittest.main()
