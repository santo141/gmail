/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import React, { PureComponent, PropTypes } from 'react';
import { connect } from 'react-redux';
import classNames from 'classnames';
import { getProfile, getProfileRootRange } from '../../reducers/profile-view';
import {
  getDataSource,
  getHash,
  getURLPredictor,
} from '../../reducers/url-state';
import { compress } from '../../utils/gz';
import {
  getProgress,
  getStatus,
  getError,
} from '../../reducers/profile-upload';
import {
  uploadBinaryProfileData,
  uploadSuccess,
  uploadError,
} from '../../actions/profile-upload';
import ArrowPanel from '../shared/ArrowPanel';
import ButtonWithPanel from '../shared/ButtonWithPanel';
import shortenURL from '../../utils/shorten-url';
import { serializeProfile } from '../../profile-logic/process-profile';
import prettyBytes from 'pretty-bytes';
import sha1 from '../../utils/sha1';
import url from 'url';

require('./ProfileSharing.css');

const PrivacyNotice = () =>
  <section className="privacyNotice">
    <p
    >{`You’re about to upload your profile publicly where anyone will be able to access it.
      To better diagnose performance problems profiles include the following information:`}</p>
    <ul>
      <li>
        {'The URLs and scripts of the tabs that were executing.'}
      </li>
      <li>
        {'The metadata of all your add-ons to identify slow add-ons.'}
      </li>
      <li>
        {'Firefox build and runtime configuration.'}
      </li>
    </ul>
    <p
    >{`To view all the information you can download the full profile to a file and open the
      json structure with a text editor.`}</p>
  </section>;

const UploadingStatus = ({ progress }) =>
  <div className="profileSharingUploadingButton">
    <div className="profileSharingUploadingButtonInner">
      <progress
        className="profileSharingUploadingButtonProgress"
        value={progress}
      />
      <div className="profileSharingUploadingButtonLabel">Uploading...</div>
    </div>
  </div>;

UploadingStatus.propTypes = {
  progress: PropTypes.number.isRequired,
};

class ProfileSharingCompositeButton extends PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      fullURL: window.location.href,
      shortURL: window.location.href,
    };
    this._attemptToShare = this._attemptToShare.bind(this);
    this._onPermalinkPanelOpen = this._onPermalinkPanelOpen.bind(this);
    this._onPermalinkPanelClose = this._onPermalinkPanelClose.bind(this);
    this._permalinkButtonCreated = elem => {
      this._permalinkButton = elem;
    };
    this._permalinkTextFieldCreated = elem => {
      this._permalinkTextField = elem;
    };
  }

  componentWillReceiveProps() {
    if (window.location.href !== this.state.fullURL) {
      this.setState({
        fullURL: window.location.href,
        shortURL: window.location.href,
      });
    }
  }

  _onPermalinkPanelOpen() {
    this._shortenURLAndFocusTextFieldOnCompletion();
  }

  _shortenURLAndFocusTextFieldOnCompletion() {
    return shortenURL(this.state.fullURL)
      .then(shortURL => {
        this.setState({ shortURL });
        if (this._permalinkTextField) {
          this._permalinkTextField.focus();
          this._permalinkTextField.select();
        }
      })
      .catch(() => {});
  }

  _onPermalinkPanelClose() {
    if (this._permalinkTextField) {
      this._permalinkTextField.blur();
    }
  }

  _attemptToShare() {
    if (this.props.status !== 'local' && this.props.status !== 'error') {
      return;
    }

    const { profile, predictURL, uploadError } = this.props;

    new Promise(resolve => {
      if (!profile) {
        throw new Error('profile is null');
      }
      const jsonString = serializeProfile(profile);
      if (!jsonString) {
        throw new Error('profile serialization failed');
      }

      resolve(jsonString);
    })
      .then(s => new TextEncoder().encode(s))
      .then(typedArray => {
        return Promise.all([compress(typedArray.slice(0)), sha1(typedArray)]);
      })
      .then(([gzipData, hash]) => {
        const predictedURL = url.resolve(
          window.location.href,
          predictURL(uploadSuccess(hash)) // uploadSuccess is used directly, so it doesn't dispatch an action
        );
        this.setState({
          fullURL: predictedURL,
          shortURL: predictedURL,
        });
        const uploadPromise = uploadBinaryProfileData(gzipData).then(() => {
          const newShortURL =
            this.state.fullURL === window.location.href
              ? this.state.shortURL
              : window.location.href;
          this.setState({
            fullURL: window.location.href,
            shortURL: newShortURL,
          });
        });
        const shortenURLPromise = this._shortenURLAndFocusTextFieldOnCompletion();
        Promise.race([uploadPromise, shortenURLPromise]).then(() => {
          if (this._permalinkButton) {
            this._permalinkButton.openPanel();
          }
        });
        return Promise.all([uploadPromise, shortenURLPromise]);
      })
      .catch(error => {
        uploadError(error);
      });
  }

  render() {
    const { shortURL } = this.state;
    const { dataSource, status, progress, error } = this.props;
    return (
      <div
        className={classNames('profileSharingCompositeButtonContainer', {
          currentButtonIsShareButton: dataSource !== 'public',
          currentButtonIsUploadingButton: status === 'uploading',
          currentButtonIsPermalinkButton: dataSource === 'public',
          currentButtonIsUploadErrorButton: status === 'error',
        })}
      >
        <ButtonWithPanel
          className="profileSharingShareButton"
          label="Share..."
          panel={
            <ArrowPanel
              className="profileSharingPrivacyPanel"
              title={'Upload Profile – Privacy Notice'}
              okButtonText="Share"
              cancelButtonText="Cancel"
              onOkButtonClick={this._attemptToShare}
            >
              <PrivacyNotice />
            </ArrowPanel>
          }
        />
        <UploadingStatus progress={progress} />
        <ButtonWithPanel
          className="profileSharingPermalinkButton"
          ref={this._permalinkButtonCreated}
          label="Permalink"
          panel={
            <ArrowPanel
              className="profileSharingPermalinkPanel"
              onOpen={this._onPermalinkPanelOpen}
              onClose={this._onPermalinkPanelClose}
            >
              <input
                type="text"
                className="profileSharingPermalinkTextField"
                value={shortURL}
                readOnly="readOnly"
                ref={this._permalinkTextFieldCreated}
              />
            </ArrowPanel>
          }
        />
        <ButtonWithPanel
          className="profileSharingUploadErrorButton"
          label="Upload Error"
          open={!!error}
          panel={
            <ArrowPanel
              className="profileSharingUploadErrorPanel"
              title={'Upload Error'}
              okButtonText="Try Again"
              cancelButtonText="Cancel"
              onOkButtonClick={this._attemptToShare}
            >
              <p>An error occurred during upload:</p>
              <pre>{`${error}`}</pre>
            </ArrowPanel>
          }
        />
      </div>
    );
  }
}

ProfileSharingCompositeButton.propTypes = {
  profile: PropTypes.object,
  dataSource: PropTypes.string.isRequired,
  hash: PropTypes.string,
  status: PropTypes.string.isRequired,
  progress: PropTypes.number,
  error: PropTypes.error,
  uploadBinaryProfileData: PropTypes.func.isRequired,
  uploadError: PropTypes.func.isRequired,
  predictURL: PropTypes.func.isRequired,
};

function filenameDateString(d) {
  const pad = x => (x < 10 ? `0${x}` : `${x}`);
  return `${pad(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

class ProfileDownloadButton extends PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      uncompressedBlobUrl: '',
      compressedBlobUrl: '',
      uncompressedSize: 0,
      compressedSize: 0,
      filename: '',
    };
    this._onPanelOpen = this._onPanelOpen.bind(this);
  }

  _onPanelOpen() {
    const { profile, rootRange } = this.props;
    const profileDate = new Date(profile.meta.startTime + rootRange.start);
    const serializedProfile = serializeProfile(profile);
    const blob = new Blob([serializedProfile], {
      type: 'application/octet-binary',
    });
    const blobURL = URL.createObjectURL(blob);
    this.setState({
      filename: `${profile.meta.product} ${filenameDateString(
        profileDate
      )} profile.sps.json`,
      uncompressedBlobUrl: blobURL,
      uncompressedSize: blob.size,
    });
    compress(serializedProfile).then(data => {
      const blob = new Blob([data], { type: 'application/octet-binary' });
      const blobURL = URL.createObjectURL(blob);
      this.setState({
        compressedBlobUrl: blobURL,
        compressedSize: blob.size,
      });
    });
  }

  render() {
    const {
      filename,
      uncompressedBlobUrl,
      compressedBlobUrl,
      uncompressedSize,
      compressedSize,
    } = this.state;
    return (
      <ButtonWithPanel
        className="profileSharingProfileDownloadButton"
        label="Save as file..."
        panel={
          <ArrowPanel
            className="profileSharingProfileDownloadPanel"
            title={'Save Profile to a Local File'}
            onOpen={this._onPanelOpen}
          >
            <section>
              {uncompressedBlobUrl
                ? <p>
                    <a
                      className="profileSharingDownloadLink"
                      href={uncompressedBlobUrl}
                      download={filename}
                    >
                      {`${filename} (${prettyBytes(uncompressedSize)})`}
                    </a>
                  </p>
                : null}
              {compressedBlobUrl
                ? <p>
                    <a
                      className="profileSharingDownloadLink"
                      href={compressedBlobUrl}
                      download={`${filename}.gz`}
                    >
                      {`${filename}.gz (${prettyBytes(compressedSize)})`}
                    </a>
                  </p>
                : null}
            </section>
          </ArrowPanel>
        }
      />
    );
  }
}

ProfileDownloadButton.propTypes = {
  profile: PropTypes.object,
  rootRange: PropTypes.object,
};

const ProfileSharing = ({
  profile,
  rootRange,
  dataSource,
  progress,
  hash,
  status,
  error,
  predictURL,
  uploadBinaryProfileData,
  uploadError,
}) =>
  <div className="profileSharing">
    <ProfileSharingCompositeButton
      profile={profile}
      dataSource={dataSource}
      progress={progress}
      hash={hash}
      error={error}
      status={status}
      uploadBinaryProfileData={uploadBinaryProfileData}
      uploadError={uploadError}
      predictURL={predictURL}
    />
    <ProfileDownloadButton profile={profile} rootRange={rootRange} />
  </div>;

ProfileSharing.propTypes = {
  profile: PropTypes.object,
  rootRange: PropTypes.object,
  dataSource: PropTypes.string.isRequired,
  hash: PropTypes.string,
  progress: PropTypes.number.isRequired,
  error: PropTypes.error,
  status: PropTypes.string.isRequired,
  predictURL: PropTypes.func.isRequired,
  uploadBinaryProfileData: PropTypes.func.isRequired,
  uploadError: PropTypes.func.isRequired,
};

export default connect(
  state => ({
    profile: getProfile(state),
    rootRange: getProfileRootRange(state),
    dataSource: getDataSource(state),
    hash: getHash(state),
    predictURL: getURLPredictor(state),
    error: getError(state),
    status: getStatus(state),
    progress: getProgress(state),
  }),
  { uploadBinaryProfileData, uploadError }
)(ProfileSharing);
